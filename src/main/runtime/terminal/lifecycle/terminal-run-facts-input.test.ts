import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInputKind } from '../../../../shared/terminal/input/terminal-input-kind'
import { writePtyFromRuntimeController } from '../../../ipc/pty/runtime/operations'
import { getLocalPtyProvider, setLocalPtyProvider } from '../../../ipc/pty/provider/registry'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { settledWriteStub } from '../../../providers/settled-pty-write-stub'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import '../../orchestration/mailbox/terminal-pointer/mailbox-pointer-pty-write'
import { sendTerminalStreamInput } from '../../rpc/methods/terminal/terminal-input-delivery'
import { makeStore } from '../../rpc/server/runtime-rpc-worktree-store-fixtures'
import '../../workspaces/startup/runtime-worktree-startup-readiness'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: listings.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listings.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  function createWorktreeListingMocks() {
    const worktrees = [
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/run-facts',
        isBare: false,
        isMainWorktree: false
      }
    ]
    return {
      listWorktrees: vi.fn().mockResolvedValue(worktrees),
      listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
    }
  }
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

const PTY_ID = 'pty-run-facts-input'
const priorProvider = getLocalPtyProvider()

type FreshRun = {
  runtime: OrcaRuntimeService
  controller: RuntimePtyController
  handle: string
  /** The kind each provider write was sent with, and whether input was recorded by then. */
  writes: { data: string; inputRecorded: boolean }[]
  kinds: TerminalInputKind[]
  firstUserInputAt: () => number | null
}

/** A fresh shell whose controller writes go through main's real write funnel to a fake provider. */
async function createFreshRun(): Promise<FreshRun> {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const firstUserInputAt = (): number | null =>
    runtime.terminalRunFacts.read(PTY_ID, null).firstUserInputAt
  const writes: FreshRun['writes'] = []
  const kinds: TerminalInputKind[] = []
  const write = (_id: string, data: string): boolean => {
    writes.push({ data, inputRecorded: firstUserInputAt() !== null })
    if (data.endsWith('\r')) {
      runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', Date.now())
    }
    return true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the write funnel calls only write and writeWithSettlement on the provider.
  setLocalPtyProvider({
    write,
    writeWithSettlement: settledWriteStub(write)
  } as unknown as IPtyProvider)
  const controller: RuntimePtyController = {
    spawn: async () => ({ id: PTY_ID }),
    write: (id, data, inputKind) => {
      kinds.push(inputKind)
      return writePtyFromRuntimeController({ runtime }, id, data, inputKind)
    },
    writeWithSettlement: (id, data, inputKind) => {
      kinds.push(inputKind)
      return writePtyFromRuntimeController({ runtime }, id, data, inputKind, {
        waitForSettlement: true
      })
    },
    kill: () => true,
    getForegroundProcess: async () => null
  }
  runtime.setPtyController(controller)
  const terminal = await runtime.createTerminal('path:/tmp/worktree-a', { launchAgent: 'aider' })
  runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
  return { runtime, controller, handle: terminal.handle, writes, kinds, firstUserInputAt }
}

afterEach(() => {
  vi.useRealTimers()
  setLocalPtyProvider(priorProvider)
})

describe('run facts: the controller write funnel', () => {
  it('records terminal.send input before the write that could end the process', async () => {
    const run = await createFreshRun()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true })
    try {
      await Promise.all([
        run.runtime.sendTerminal(
          run.handle,
          { text: 'exit', enter: true },
          { inputKind: 'driving' }
        ),
        vi.runAllTimersAsync()
      ])

      expect(run.firstUserInputAt()).not.toBeNull()
      expect(run.writes.map((write) => write.inputRecorded)).toEqual([true, true])
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('reads a run launched with a prompt as untyped until someone drives it', async () => {
    vi.useFakeTimers()
    const run = await createFreshRun()

    const submission = run.runtime.sendTerminalAgentPrompt(run.handle, 'start here', {
      inputKind: 'launch'
    })
    await vi.runAllTimersAsync()
    await submission.catch(() => undefined)

    expect(run.writes.length).toBeGreaterThan(0)
    expect(run.firstUserInputAt()).toBeNull()

    await run.runtime.sendTerminal(run.handle, { text: 'y' }, { inputKind: 'driving' })
    expect(run.firstUserInputAt()).not.toBeNull()
  })

  it.each([
    ['a terminal reply', '\x1b[3;4R'],
    ['focus reports', '\x1b[I\x1b[O'],
    ['the focus-in a desktop sends on reattaching a remote pane', '\x1b[I']
  ])('records nothing for stream input that is only %s', async (_label, text) => {
    const run = await createFreshRun()

    await sendTerminalStreamInput(run.runtime, {
      terminal: run.handle,
      text,
      client: undefined,
      isMobile: false
    })

    expect(run.writes).toHaveLength(1)
    expect(run.firstUserInputAt()).toBeNull()
  })

  it('records dashboard preview typing before the write that could end the process', async () => {
    const run = await createFreshRun()

    await expect(run.runtime.writeTerminalPreviewInput(PTY_ID, 'exit\r')).resolves.toBe(true)

    expect(run.writes.map((write) => write.inputRecorded)).toEqual([true])
  })
})
