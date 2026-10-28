import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { registerBoundPty } from './bind-first-pane.test-fixture'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

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
  it('inspects the retained SSH PTY during renderer reload without an input write', async () => {
    const { runtime } = makeRuntime()
    const handle = runtime.preAllocateHandleForPty(PTY_ID)
    register(runtime, 'incarnation-1')
    syncGraph(runtime)
    const inspectProcess = vi.fn().mockResolvedValue({ foregroundProcess: 'codex' })
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: () => true,
      getForegroundProcess: async () => null,
      inspectProcess
    })
    expect(runtime.markRendererReloading(1)).not.toBeNull()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test fixture crosses a private/runtime boundary with a verified shape.
    expect((runtime as unknown as { handles: Map<string, unknown> }).handles.has(handle)).toBe(
      false
    )
    await expect(
      runtime.inspectTerminalProcess(handle, { expectedIncarnationId: 'incarnation-1' })
    ).resolves.toEqual({ foregroundProcess: 'codex' })
    expect(inspectProcess).toHaveBeenCalledWith(PTY_ID, { expectedIncarnationId: 'incarnation-1' })
  })

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

  it('keeps a listed handle when graph sync learns the incarnation after issue', async () => {
    // Output can mint an unfenced handle before spawn commit supplies incarnation; learning it must retain the handle.
    const { runtime } = makeRuntime()
    runtime.registerPty(PTY_ID, WORKTREE_ID, 'target', { tabId: TAB_ID, leafId: LEAF_ID })
    syncGraph(runtime)
    const [listed] = (await runtime.listTerminals()).terminals

    register(runtime, 'incarnation-learned')
    syncGraph(runtime)

    await expect(runtime.readTerminal(listed.handle)).resolves.toMatchObject({
      handle: listed.handle,
      status: 'running'
    })
  })

  it('stales a listed handle when graph sync sees a replaced incarnation', async () => {
    const { runtime } = makeRuntime()
    register(runtime, 'incarnation-old')
    syncGraph(runtime)
    const [listed] = (await runtime.listTerminals()).terminals

    // Rotate the record directly so reconcile is the only fence exercised.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test fixture crosses a private/runtime boundary with a verified shape.
    const internals = runtime as unknown as {
      ptysById: Map<string, { incarnationId: string | null }>
    }
    internals.ptysById.get(PTY_ID)!.incarnationId = 'incarnation-new'
    syncGraph(runtime)

    await expect(runtime.readTerminal(listed.handle)).rejects.toThrow('terminal_handle_stale')
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

  it('invalidates the predecessor before registration when spawn notification updates incarnation', async () => {
    const { runtime } = makeRuntime()
    const staleHandle = runtime.preAllocateHandleForPty(PTY_ID)
    register(runtime, 'incarnation-old')
    syncGraph(runtime)
    await expect(runtime.readTerminal(staleHandle)).resolves.toMatchObject({ status: 'running' })

    // Local provider spawn notification precedes pane registration.
    runtime.onPtySpawned(PTY_ID, 'incarnation-new', { awaitsRegistration: false })
    // Old env handles requested during preflight must not resurrect aliases after spawn fencing.
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

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test fixture crosses a private/runtime boundary with a verified shape.
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
  // App SSH id embeds target, so its scope is ssh:target.
  const SSH_TARGET_SCOPE = JSON.stringify({ kind: 'ssh', targetId: 'target' })

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

  function resolve(
    runtime: OrcaRuntimeService,
    processIncarnation: string,
    serializedHostScope: string | null
  ): string | null {
    return runtime.resolveTerminalHandleByProcessIncarnation(
      processIncarnation,
      serializedHostScope
    )
  }

  it('mints a live handle for a pty whose exact incarnation and host scope match', () => {
    const { runtime } = makeRuntime()
    seedPty(runtime, PTY_ID, 'incarnation-1')
    const handle = resolve(runtime, `${PTY_ID}:incarnation-1`, SSH_TARGET_SCOPE)
    expect(handle).toMatch(/^term_/)
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
    // Never match modern incarnation probes against unfenced PTYs.
    expect(resolve(runtime, `${PTY_ID}:incarnation-1`, LOCAL_SCOPE)).toBeNull()
    // Legacy generation-shaped probes remain fail-closed; never guess incarnation.
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

  it('keeps scanning past a colon-ambiguous decoy in another host scope to the genuine match', () => {
    const { runtime } = makeRuntime({ paneLayout: true })
    // relay + conn:incarnation-1 and relay:conn + incarnation-1 collide as strings; wrong-host decoy is registered first.
    const processIncarnation = 'relay:conn:incarnation-1'
    const DECOY_TAB_ID = 'tab-decoy'
    const DECOY_LEAF_ID = '22222222-2222-4222-8222-222222222222'
    const GENUINE_TAB_ID = 'tab-genuine'
    const GENUINE_LEAF_ID = '33333333-3333-4333-8333-333333333333'
    registerBoundPty(runtime, 'relay', WORKTREE_ID, 'decoy', {
      tabId: DECOY_TAB_ID,
      leafId: DECOY_LEAF_ID,
      incarnationId: 'conn:incarnation-1'
    })
    registerBoundPty(runtime, 'relay:conn', WORKTREE_ID, null, {
      tabId: GENUINE_TAB_ID,
      leafId: GENUINE_LEAF_ID,
      incarnationId: 'incarnation-1'
    })

    // Wrong-host matches must continue scanning so they cannot shadow a later same-scope PTY.
    const handle = resolve(runtime, processIncarnation, LOCAL_SCOPE)
    expect(handle).toMatch(/^term_/)
    // Colliding incarnation strings cannot distinguish panes; verify the reminted handle targets the genuine pane key.
    const genuinePaneKey = makePaneKey(GENUINE_TAB_ID, GENUINE_LEAF_ID)
    const decoyPaneKey = makePaneKey(DECOY_TAB_ID, DECOY_LEAF_ID)
    expect(runtime.getTerminalPaneKey(handle!)).toBe(genuinePaneKey)
    expect(runtime.getTerminalPaneKey(handle!)).not.toBe(decoyPaneKey)
  })
})
