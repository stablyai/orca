// A reversible sleep stop keeps the pane's accepted Done through provider and runtime exit.
import { expect, it, vi } from 'vitest'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const { HEADLESS_SECOND_LEAF_ID, TEST_WORKTREE_ID } =
  await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')
const { SURFACE_TAB_ID, surfaceRuntime, mountedSurfaceGraph } =
  await import('./terminal-surface-replies.test-fixture')

const PANE_B = `${SURFACE_TAB_ID}:${HEADLESS_SECOND_LEAF_ID}`

it.each([
  { launched: false, providerFirst: true },
  { launched: true, providerFirst: true },
  { launched: false, providerFirst: false },
  { launched: true, providerFirst: false }
])(
  'keeps slept Done through provider and runtime exit ($launched, providerFirst=$providerFirst)',
  async ({ launched, providerFirst }) => {
    const { agentHookServer: server, _internals } =
      await import('../../../agent-hooks/server/agent-hook-server')
    const { agentHookRuntimeDeps } =
      await import('../../../agent-hooks/runtime/agent-hook-runtime-deps')
    const { clearProviderPtyState } = await import('../../../ipc/pty/provider/state-cleanup')
    const { paneKeyPtyId, ptyPaneKey } = await import('../../../ipc/pty/pane/key-state')
    const { ptyIncarnationById } = await import('../../../ipc/pty/provider/ownership-state')
    _internals.resetCachesForTests()
    server.restorePaneAuthority(PANE_B)
    const { runtime } = surfaceRuntime()
    const deps = agentHookRuntimeDeps(server, { read: () => ({ kind: 'unobserved' }) }, () => ({}))
    Reflect.set(
      runtime,
      'reconcileAgentStatusForEndedProcessFn',
      deps.reconcileAgentStatusForEndedProcess
    )
    const retireAuthority = vi.fn((key: string) => server.retireProcessAuthority(key))
    Reflect.set(runtime, 'retireAgentHookCompatibilityAuthorityFn', retireAuthority)
    runtime.registerPty('pty-b', TEST_WORKTREE_ID, null, {
      tabId: SURFACE_TAB_ID,
      leafId: HEADLESS_SECOND_LEAF_ID,
      incarnationId: 'inc-b',
      ...(launched
        ? {
            agentLaunchAuthority: {
              launchToken: 'sleep-test-launch',
              launchAgent: 'claude' as const,
              launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} }
            }
          }
        : {})
    })
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, mountedSurfaceGraph())
    paneKeyPtyId.set(PANE_B, 'pty-b')
    ptyPaneKey.set('pty-b', PANE_B)
    ptyIncarnationById.set('pty-b', 'inc-b')
    server.setTerminalPaneLifecycle({
      ownsProcess: (key, id, incarnation) =>
        key === PANE_B && id === 'pty-b' && incarnation === 'inc-b',
      isStopping: () =>
        runtime.intentionalPtyStops.claimExit('pty-b', 'inc-b').includes('reversible'),
      isReversibleStop: (id, incarnation) =>
        runtime.intentionalPtyStops.claimExit(id, incarnation).includes('reversible'),
      isPlaced: () => true
    })
    server.ingestTerminalStatus({
      paneKey: PANE_B,
      tabId: SURFACE_TAB_ID,
      worktreeId: TEST_WORKTREE_ID,
      connectionId: null,
      payload: { state: 'done', agentType: 'claude', prompt: 'Finished work' }
    })
    const before = server.getStatusSnapshotForPane(PANE_B)[0]
    const emitted = vi.fn()
    server.setListener(emitted)
    const finishStop = runtime.intentionalPtyStops.mark('pty-b', 'reversible', 'inc-b')
    try {
      if (providerFirst) {
        clearProviderPtyState('pty-b', { exitProven: true })
        expect(server.getStatusSnapshotForPane(PANE_B)[0]).toMatchObject({
          state: 'done',
          paneSleep: { ptyId: 'pty-b', incarnationId: 'inc-b' }
        })
      }
      await runtime.onPtyExit('pty-b', 0, 'inc-b', { providerExitObserved: true })
      if (!providerFirst) {
        clearProviderPtyState('pty-b', { exitProven: true })
      }
      if (launched) {
        expect(retireAuthority).toHaveBeenCalledWith(PANE_B)
      }
      expect(server.getStatusSnapshotForPane(PANE_B)[0]).toMatchObject({
        state: 'done',
        paneSleep: { ptyId: 'pty-b', incarnationId: 'inc-b' },
        receivedAt: before.receivedAt,
        stateStartedAt: before.stateStartedAt
      })
      expect(emitted.mock.calls.filter(([row]) => !row.isReplay)).toHaveLength(0)
      server.retirePaneAuthority(PANE_B)
      expect(server.getStatusSnapshotForPane(PANE_B)).toEqual([])
    } finally {
      server.setListener(null)
      finishStop(true)
      paneKeyPtyId.delete(PANE_B)
      ptyPaneKey.delete('pty-b')
      ptyIncarnationById.delete('pty-b')
      _internals.resetCachesForTests()
    }
  }
)
