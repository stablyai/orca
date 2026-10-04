import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import { writePtyFromRuntimeController } from '../ipc/pty/runtime/operations'
import { getLocalPtyProvider, setLocalPtyProvider } from '../ipc/pty/provider/registry'
import type { IPtyProvider } from '../providers/types'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { writeOrchestrationPointerWithSettlement } from './orchestration/mailbox-pointer-pty-write'
import { sendTerminalStreamInput } from './rpc/methods/terminal/terminal-input-delivery'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import {
  pasteWorktreeStartupDraftWhenReady,
  sendWorktreeStartupFollowupWhenReady,
  type WorktreeStartupReadinessHost
} from './runtime-worktree-startup-readiness'

vi.mock('../git/worktree', () => {
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

    await run.runtime.sendTerminal(
      run.handle,
      { text: 'exit', enter: true },
      { inputKind: 'driving' }
    )

    expect(run.firstUserInputAt()).not.toBeNull()
    expect(run.writes.map((write) => write.inputRecorded)).toEqual([true, true])
  })

  it('records stream input from a client', async () => {
    const run = await createFreshRun()

    await sendTerminalStreamInput(run.runtime, {
      terminal: run.handle,
      text: 'l',
      client: undefined,
      isMobile: false
    })

    expect(run.firstUserInputAt()).not.toBeNull()
  })

  it('records a dispatched agent prompt before its first write', async () => {
    vi.useFakeTimers()
    const run = await createFreshRun()

    const submission = run.runtime.sendTerminalAgentPrompt(run.handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()
    await submission.catch(() => undefined)

    expect(run.firstUserInputAt()).not.toBeNull()
    expect(run.writes[0]?.inputRecorded).toBe(true)
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

  it('records a mailbox pointer, which drives the running agent', async () => {
    const run = await createFreshRun()

    await writeOrchestrationPointerWithSettlement({
      ptyId: PTY_ID,
      data: 'You have 1 unread message.',
      controller: run.controller
    })

    expect(run.kinds).toEqual(['driving'])
    expect(run.firstUserInputAt()).not.toBeNull()
  })

  it('records nothing for a client query reply', async () => {
    const run = await createFreshRun()

    await run.runtime.sendTerminal(run.handle, { text: 'y' }, { inputKind: 'query-reply' })

    expect(run.firstUserInputAt()).toBeNull()
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

  it('records a reply mixed with a keystroke', async () => {
    const run = await createFreshRun()

    await run.runtime.sendTerminal(run.handle, { text: '\x1b[3;4Rx' }, { inputKind: 'driving' })

    expect(run.firstUserInputAt()).not.toBeNull()
  })

  it('records dashboard preview typing before the write that could end the process', async () => {
    const run = await createFreshRun()

    await expect(run.runtime.writeTerminalPreviewInput(PTY_ID, 'exit\r')).resolves.toBe(true)

    expect(run.writes.map((write) => write.inputRecorded)).toEqual([true])
  })

  it('records nothing for dashboard preview bytes that are only a reply or focus reports', async () => {
    const run = await createFreshRun()

    await run.runtime.writeTerminalPreviewInput(PTY_ID, '\x1b[3;4R')
    await run.runtime.writeTerminalPreviewInput(PTY_ID, '\x1b[O\x1b[I')

    expect(run.writes).toHaveLength(2)
    expect(run.firstUserInputAt()).toBeNull()
  })
})

describe('run facts: a created worktree’s startup writes', () => {
  function readinessHost(run: FreshRun): WorktreeStartupReadinessHost {
    return {
      getPtyId: () => PTY_ID,
      getForegroundProcess: async () => 'aider',
      subscribeToData: () => () => {},
      // Why: bracketed paste enabled, then quiet, is the default draft-ready signal.
      readRecentOutput: () => '\x1b[?2004h',
      write: (ptyId, data, inputKind) => run.controller.write(ptyId, data, inputKind)
    }
  }

  it('reads a run whose only input was its create-time draft and follow-up as untyped', async () => {
    vi.useFakeTimers()
    const run = await createFreshRun()
    const host = readinessHost(run)

    pasteWorktreeStartupDraftWhenReady(host, run.handle, { agent: 'aider', content: 'plan it' })
    sendWorktreeStartupFollowupWhenReady(host, run.handle, {
      expectedProcess: 'aider',
      prompt: 'and ship it'
    })
    await vi.runAllTimersAsync()

    expect(run.kinds).toEqual(['launch', 'launch'])
    expect(run.writes).toHaveLength(2)
    expect(run.firstUserInputAt()).toBeNull()
  })
})
