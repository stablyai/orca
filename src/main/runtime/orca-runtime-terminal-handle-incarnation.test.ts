import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const PTY_ID = 'ssh:target@@relay-pty'
const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-terminal'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function makeRuntime(): { runtime: OrcaRuntimeService; writes: string[] } {
  const writes: string[] = []
  const runtime = new OrcaRuntimeService(null)
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

function syncGraph(runtime: OrcaRuntimeService): void {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
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
  it('preserves a direct handle while the PTY incarnation is unchanged', async () => {
    const { runtime } = makeRuntime()
    const handle = runtime.preAllocateHandleForPty(PTY_ID)
    register(runtime, 'incarnation-1')
    syncGraph(runtime)

    register(runtime, 'incarnation-1')

    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      handle,
      status: 'running'
    })
  })

  it('treats a null-to-known incarnation as the same un-fenced PTY', async () => {
    const { runtime } = makeRuntime()
    const handle = runtime.preAllocateHandleForPty(PTY_ID)
    runtime.registerPty(PTY_ID, WORKTREE_ID, 'target', {
      tabId: TAB_ID,
      leafId: LEAF_ID
    })
    syncGraph(runtime)

    runtime.registerPty(PTY_ID, WORKTREE_ID, 'target', {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'incarnation-learned'
    })

    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({ handle, status: 'running' })
  })

  it('invalidates a direct handle when a reused PTY id gets a new incarnation', async () => {
    const { runtime, writes } = makeRuntime()
    const staleHandle = runtime.preAllocateHandleForPty(PTY_ID)
    register(runtime, 'incarnation-old')
    syncGraph(runtime)
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
    await expect(runtime.sendTerminal(staleHandle, { text: 'stale input' })).rejects.toThrow(
      'terminal_handle_stale'
    )

    await expect(
      runtime.sendTerminal(replacement!.handle, { text: 'replacement input' })
    ).resolves.toMatchObject({
      accepted: true,
      handle: replacement!.handle
    })
    expect(writes).toEqual(['replacement input'])
  })

  it('invalidates the predecessor before registration when spawn notification updates incarnation', async () => {
    const { runtime } = makeRuntime()
    const staleHandle = runtime.preAllocateHandleForPty(PTY_ID)
    register(runtime, 'incarnation-old')
    syncGraph(runtime)
    await expect(runtime.readTerminal(staleHandle)).resolves.toMatchObject({ status: 'running' })

    // Local providers notify the runtime as soon as the child starts, before
    // the spawn commit calls registerPty with its pane binding.
    runtime.onPtySpawned(PTY_ID, 'incarnation-new', { awaitsRegistration: false })
    // A provider that asks for the old env handle during its preflight must not
    // be able to resurrect that alias after the notification fence.
    runtime.registerPreAllocatedHandleForPty(PTY_ID, staleHandle)
    register(runtime, 'incarnation-new')

    await expect(runtime.readTerminal(staleHandle)).rejects.toThrow('terminal_handle_stale')
  })

  it('does not let a delayed predecessor handle callback resurrect the replacement alias', async () => {
    const { runtime } = makeRuntime()
    const staleHandle = runtime.preAllocateHandleForPty(PTY_ID)
    register(runtime, 'incarnation-old')
    syncGraph(runtime)
    runtime.onPtySpawned(PTY_ID, 'incarnation-new', { awaitsRegistration: false })
    const replacementHandle = runtime.createPreAllocatedTerminalHandle()
    runtime.registerPreAllocatedHandleForPty(PTY_ID, replacementHandle)
    register(runtime, 'incarnation-new')

    runtime.registerPreAllocatedHandleForPty(PTY_ID, staleHandle)
    await expect(runtime.readTerminal(staleHandle)).rejects.toThrow('terminal_handle_stale')
  })

  it('keeps only the direct replacement alias when its renderer record is stale', async () => {
    const { runtime } = makeRuntime()
    runtime.registerPty(PTY_ID, WORKTREE_ID, 'target', {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'incarnation-old'
    })
    const replacementHandle = runtime.createPreAllocatedTerminalHandle()
    runtime.registerPreAllocatedHandleForPty(PTY_ID, replacementHandle)
    syncGraph(runtime)

    const internals = runtime as unknown as {
      handles: Map<string, unknown>
      handleByLeafKey: Map<string, string>
    }
    expect(internals.handles.has(replacementHandle)).toBe(true)
    expect(internals.handleByLeafKey.get(`${TAB_ID}::${LEAF_ID}`)).toBe(replacementHandle)

    runtime.registerPty(PTY_ID, WORKTREE_ID, 'target', {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'incarnation-new',
      terminalHandle: replacementHandle
    })

    expect(internals.handles.has(replacementHandle)).toBe(false)
    expect(internals.handleByLeafKey.has(`${TAB_ID}::${LEAF_ID}`)).toBe(false)
    await expect(runtime.readTerminal(replacementHandle)).resolves.toMatchObject({
      handle: replacementHandle,
      status: 'running'
    })
  })
})
