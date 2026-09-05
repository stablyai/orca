import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const PTY_ID = 'ssh:target@@relay-pty'
const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-terminal'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

/** A runtime whose pty controller captures every write for assertion. */
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

/** Attach a window and publish a one-tab, one-leaf terminal graph. */
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

/** (Re)register the fixture pty leaf under the given incarnation id. */
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

describe('resolveTerminalHandleByProcessIncarnation direct fencing', () => {
  const LOCAL_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })
  // PTY_ID ('ssh:target@@relay-pty') derives connectionId 'target' via parseAppSshPtyId, so its
  // host scope is ssh:target rather than local.
  const SSH_TARGET_SCOPE = JSON.stringify({ kind: 'ssh', targetId: 'target' })

  /** Register a pty leaf directly, optionally under a connection and incarnation. */
  function seedPty(
    runtime: OrcaRuntimeService,
    ptyId: string,
    incarnationId: string | null,
    connectionId: string | null = null
  ): void {
    runtime.registerPty(ptyId, WORKTREE_ID, connectionId, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      ...(incarnationId ? { incarnationId } : {})
    })
  }

  /** Call the private resolveTerminalHandleByProcessIncarnation on the runtime. */
  function resolve(
    runtime: OrcaRuntimeService,
    processIncarnation: string,
    serializedHostScope: string | null
  ): string | null {
    return (
      runtime as unknown as {
        resolveTerminalHandleByProcessIncarnation(
          processIncarnation: string,
          serializedHostScope: string | null
        ): string | null
      }
    ).resolveTerminalHandleByProcessIncarnation(processIncarnation, serializedHostScope)
  }

  it('mints a live handle for a pty whose exact incarnation and host scope match', () => {
    const { runtime } = makeRuntime()
    seedPty(runtime, PTY_ID, 'incarnation-1')
    const handle = resolve(runtime, `${PTY_ID}:incarnation-1`, SSH_TARGET_SCOPE)
    expect(handle).toMatch(/^term_/)
    // Re-minting the same live pty is idempotent.
    expect(resolve(runtime, `${PTY_ID}:incarnation-1`, SSH_TARGET_SCOPE)).toBe(handle)
  })

  it('returns null when the recorded incarnationId no longer matches the live pty', () => {
    const { runtime } = makeRuntime()
    seedPty(runtime, PTY_ID, 'incarnation-1')
    expect(resolve(runtime, `${PTY_ID}:incarnation-2`, LOCAL_SCOPE)).toBeNull()
  })

  it('returns null when the live pty has no incarnationId (legacy runtimeId:ptyId:gen never reaps)', () => {
    const { runtime } = makeRuntime()
    seedPty(runtime, PTY_ID, null)
    // A modern-shaped probe cannot match a pty that carries no incarnationId...
    expect(resolve(runtime, `${PTY_ID}:incarnation-1`, LOCAL_SCOPE)).toBeNull()
    // ...and the legacy `${runtimeId}:${ptyId}:${ptyGeneration}` shape stays fail-closed rather
    // than reap on a ptyGeneration guess.
    expect(resolve(runtime, `runtime_test:${PTY_ID}:0`, LOCAL_SCOPE)).toBeNull()
  })

  it('returns null when the host scope does not match', () => {
    const { runtime } = makeRuntime()
    seedPty(runtime, PTY_ID, 'incarnation-1')
    expect(
      resolve(runtime, `${PTY_ID}:incarnation-1`, JSON.stringify({ kind: 'ssh', targetId: 'nope' }))
    ).toBeNull()
  })

  it('returns null when no host scope is supplied (fails closed)', () => {
    const { runtime } = makeRuntime()
    seedPty(runtime, PTY_ID, 'incarnation-1')
    expect(resolve(runtime, `${PTY_ID}:incarnation-1`, null)).toBeNull()
  })

  it('resolves a colon-bearing SSH/relay incarnationId that lastIndexOf would mis-split', () => {
    const { runtime } = makeRuntime()
    // PTY_ID already carries ':' and '@@'; the incarnationId itself also carries colons.
    seedPty(runtime, PTY_ID, 'relay:conn-3:incarnation-9', 'target')
    const handle = resolve(
      runtime,
      `${PTY_ID}:relay:conn-3:incarnation-9`,
      JSON.stringify({ kind: 'ssh', targetId: 'target' })
    )
    expect(handle).toMatch(/^term_/)
  })

  it('resolves a Windows repo::C:\\path@@1 ptyId', () => {
    const { runtime } = makeRuntime()
    const windowsPtyId = 'repo::C:\\path@@1'
    seedPty(runtime, windowsPtyId, 'incarnation-win')
    const handle = resolve(runtime, `${windowsPtyId}:incarnation-win`, LOCAL_SCOPE)
    expect(handle).toMatch(/^term_/)
  })
})
