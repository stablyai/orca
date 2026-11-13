// Close drops panes before terminal exit; main must recover their closed-pane identity even headless (L80 Q2).
import { expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/runtime-session-contracts'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const { HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID, TEST_WORKTREE_ID } =
  await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')
await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
const { SURFACE_TAB_ID, SURFACE_PTYS, surfaceRuntime, mountedSurfaceGraph } =
  await import('./terminal-surface-replies.test-fixture')

const PANE_A = `${SURFACE_TAB_ID}:${HEADLESS_LEAF_ID}`
const PANE_B = `${SURFACE_TAB_ID}:${HEADLESS_SECOND_LEAF_ID}`
const INCARNATIONS: Record<string, string> = { 'pty-a': 'inc-a', 'pty-b': 'inc-b' }

type Host = 'no window' | 'a window'
type Harness = ReturnType<typeof surfaceRuntime>
type Runtime = Harness['runtime']

/** The scenario's split tab, each pane bound to its terminal's incarnation, as a spawn commit leaves it. */
function closingHost(host: Host): Harness & { reconciled: string[] } {
  const harness = surfaceRuntime()
  const { runtime, store, setSession } = harness
  setSession({
    ...store.getSession(),
    terminalPtyIncarnationsByPaneKey: { [PANE_A]: 'inc-a', [PANE_B]: 'inc-b' }
  })
  for (const [leafId, ptyId] of Object.entries(SURFACE_PTYS)) {
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
      tabId: SURFACE_TAB_ID,
      leafId,
      incarnationId: INCARNATIONS[ptyId]
    })
  }
  if (host === 'a window') {
    runtime.attachWindow(1)
  }
  runtime.syncWindowGraph(host === 'a window' ? 1 : HEADLESS_RUNTIME_WINDOW_ID, {
    tabs: [],
    leaves: []
  })
  const reconciled: string[] = []
  watchReconciled(runtime, reconciled)
  return { ...harness, reconciled }
}

function watchReconciled(runtime: Runtime, into: string[]): void {
  Reflect.set(runtime, 'reconcileAgentStatusForEndedProcessFn', (keys: Set<string>) => {
    into.push(...keys)
  })
}

/** The CLI's close of pty-b's pane by its handle; the tab stays open with pty-a's pane. */
async function closePaneByHandle(runtime: Runtime): Promise<void> {
  const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
  await runtime.closeTerminal(
    listed.terminals.find((terminal) => terminal.ptyId === 'pty-b')!.handle
  )
}

/** The window's own tab close, as `layout.apply` forwards it; the window kills the terminals. */
async function closeTabAsWindow(runtime: Runtime): Promise<void> {
  await runtime['store']!.applyLayoutCommand!(
    {
      type: 'closeTabs',
      workspace: TEST_WORKTREE_ID,
      tabIds: [SURFACE_TAB_ID],
      force: true,
      recordClose: 'user'
    },
    ['local']
  )
}

async function phoneShowsPane(runtime: Runtime, leafId: string): Promise<boolean> {
  const phone = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  return phone.tabs.some(
    (tab) => tab.type === 'terminal' && tab.parentTabId === SURFACE_TAB_ID && tab.leafId === leafId
  )
}

const CLOSES = [
  { route: 'a pane closed by handle in a tab that stays', close: closePaneByHandle },
  { route: 'the window’s tab close', close: closeTabAsWindow }
] as const

for (const host of ['no window', 'a window'] as const) {
  for (const { route, close } of CLOSES) {
    it(`close then exit retires the pane's agent status and phone row: ${route}, with ${host}`, async () => {
      const harness = closingHost(host)

      await close(harness.runtime)
      expect(harness.store.getSession().closedTerminalPanesByPaneKey?.[PANE_B]).toMatchObject({
        ptyId: 'pty-b',
        incarnationId: 'inc-b',
        worktreeId: TEST_WORKTREE_ID
      })
      harness.runtime.onPtyExit('pty-b', 0, 'inc-b')

      expect(harness.reconciled).toContain(PANE_B)
      expect(harness.store.getSession().closedTerminalPanesByPaneKey?.[PANE_B]).toBeUndefined()
      expect(await phoneShowsPane(harness.runtime, HEADLESS_SECOND_LEAF_ID)).toBe(false)
    })

    it(`exit then close retires them too: ${route}, with ${host}`, async () => {
      const harness = closingHost(host)

      harness.runtime.onPtyExit('pty-b', 0, 'inc-b')
      await close(harness.runtime).catch(() => {})

      expect(harness.reconciled).toContain(PANE_B)
      expect(await phoneShowsPane(harness.runtime, HEADLESS_SECOND_LEAF_ID)).toBe(false)
    })

    it(`close, restart, then exit still finds the pane from disk: ${route}, with ${host}`, async () => {
      const harness = closingHost(host)
      await close(harness.runtime)

      // The relaunch reattaches the closed pane's live terminal; no pane holds it any more.
      const relaunched = new OrcaRuntimeService(harness.runtime['store'])
      relaunched.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => []
      })
      if (host === 'a window') {
        relaunched.attachWindow(1)
      }
      relaunched.syncWindowGraph(host === 'a window' ? 1 : HEADLESS_RUNTIME_WINDOW_ID, {
        tabs: [],
        leaves: []
      })
      relaunched.registerPty('pty-b', TEST_WORKTREE_ID)
      relaunched['terminalIdentity'].setPtyIncarnationId(
        relaunched['ptysById'].get('pty-b')!,
        'inc-b'
      )
      const reconciled: string[] = []
      watchReconciled(relaunched, reconciled)

      relaunched.onPtyExit('pty-b', 0, 'inc-b')

      expect(reconciled).toContain(PANE_B)
      expect(harness.store.getSession().closedTerminalPanesByPaneKey?.[PANE_B]).toBeUndefined()
    })

    it(`does not take the closed pane for a later incarnation of the id: ${route}, with ${host}`, async () => {
      const harness = closingHost(host)
      await close(harness.runtime)
      harness.runtime['terminalIdentity'].setPtyIncarnationId(
        harness.runtime['ptysById'].get('pty-b')!,
        'inc-later'
      )

      harness.runtime.onPtyExit('pty-b', 0, 'inc-later')

      expect(harness.reconciled).not.toContain(PANE_B)
      expect(harness.store.getSession().closedTerminalPanesByPaneKey?.[PANE_B]).toBeDefined()
    })
  }
}

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
    runtime.syncWindowGraph(1, mountedSurfaceGraph())
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
