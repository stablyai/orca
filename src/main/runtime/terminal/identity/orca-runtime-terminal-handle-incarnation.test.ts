import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import '../../../../shared/workspace-layout/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import '../../orca-runtime-tests/bind-first-pane.test-fixture'
import { partialRuntimeStore } from '../../orca-runtime-tests/runtime-store-partial-fixture'

const PTY_ID = 'ssh:target@@relay-pty'
const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-terminal'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function makeRuntime(opts: { paneLayout?: boolean } = {}): {
  runtime: OrcaRuntimeService
  writes: string[]
} {
  const writes: string[] = []
  // Main-owned pane lookup requires a layout store.
  const store = opts.paneLayout && ORCA_LAYOUT_OWNER_IS_MAIN ? partialRuntimeStore() : null
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    write: (_ptyId, data) => {
      writes.push(data)
      return true
    },
    kill: vi.fn(() => true),
    getForegroundProcess: async () => null
  })
  return { runtime, writes }
}

async function syncGraph(runtime: OrcaRuntimeService): Promise<void> {
  runtime.attachWindow(1)
  await runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID
      }
    ]
  })
}

function register(runtime: OrcaRuntimeService, incarnationId: string): void {
  runtime.registerPty(PTY_ID, WORKTREE_ID, 'target', {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId
  })
}

describe('runtime terminal handle incarnation fencing', () => {
  it('invalidates a direct handle when a reused PTY id gets a new incarnation', async () => {
    const { runtime, writes } = makeRuntime()
    const staleHandle = runtime.preAllocateHandleForPty(PTY_ID)
    register(runtime, 'incarnation-old')
    await syncGraph(runtime)
    await expect(runtime.readTerminal(staleHandle)).resolves.toMatchObject({
      handle: staleHandle,
      status: 'running'
    })

    register(runtime, 'incarnation-new')
    const [replacement] = (await runtime.listTerminals()).terminals
    expect(replacement).toMatchObject({
      ptyId: PTY_ID,
      incarnationId: 'incarnation-new'
    })
    expect(replacement?.handle).not.toBe(staleHandle)
    await expect(runtime.readTerminal(staleHandle)).rejects.toThrow('terminal_handle_stale')
    await expect(
      runtime.sendTerminal(staleHandle, { text: 'stale input' }, { inputKind: 'driving' })
    ).rejects.toThrow('terminal_handle_stale')

    await expect(
      runtime.sendTerminal(
        replacement!.handle,
        { text: 'replacement input' },
        { inputKind: 'driving' }
      )
    ).resolves.toMatchObject({
      accepted: true,
      handle: replacement!.handle
    })
    expect(writes).toEqual(['replacement input'])
  })

  it('does not let a delayed predecessor handle callback resurrect the replacement alias', async () => {
    const { runtime } = makeRuntime()
    const staleHandle = runtime.preAllocateHandleForPty(PTY_ID)
    register(runtime, 'incarnation-old')
    await syncGraph(runtime)
    runtime.onPtySpawned(PTY_ID, 'incarnation-new', { awaitsRegistration: false })
    const replacementHandle = runtime.createPreAllocatedTerminalHandle()
    runtime.registerPreAllocatedHandleForPty(PTY_ID, replacementHandle)
    register(runtime, 'incarnation-new')

    runtime.registerPreAllocatedHandleForPty(PTY_ID, staleHandle)
    await expect(runtime.readTerminal(staleHandle)).rejects.toThrow('terminal_handle_stale')
  })
})
