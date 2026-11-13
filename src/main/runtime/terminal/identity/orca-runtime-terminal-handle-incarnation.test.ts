import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { registerBoundPty } from '../../orca-runtime-tests/bind-first-pane.test-fixture'
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

describe('resolveTerminalHandleByProcessIncarnation direct fencing', () => {
  const LOCAL_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })
  // App SSH id embeds target, so its scope is ssh:target.

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
