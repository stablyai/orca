import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const reconciliationHookSource = readFileSync(
  new URL('./use-mobile-session-tabs-reconciliation.ts', import.meta.url),
  'utf8'
)
const autoCreateHookSource = readFileSync(
  new URL('./use-initial-session-terminal-autocreate.ts', import.meta.url),
  'utf8'
)

function sliceBetween(startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('mobile session startup', () => {
  it('auto-creates one terminal for a newly created empty session', () => {
    expect(source).toContain('useWorktreeSessionTabsLoaded(worktreeId)')
    expect(source).toContain(
      'initialSessionAutoCreateRef.current = createInitialSessionAutoCreateState()'
    )

    const autoCreateCall = sliceBetween(
      'useInitialSessionTerminalAutoCreate({',
      'const connectionVerdict ='
    )
    expect(autoCreateCall).toContain('stateRef: initialSessionAutoCreateRef')
    expect(autoCreateCall).toContain(
      'consumeCreationRoute: () => router.setParams({ created: undefined })'
    )
    expect(autoCreateCall).toContain("newlyCreatedWorkspace: created === '1'")
    expect(autoCreateCall).toContain('visibleTabCount: visibleTabs.length')
    expect(autoCreateCall).toContain('createTerminal: () => void handleCreateTerminal()')

    expect(autoCreateHookSource).toContain('shouldAutoCreateInitialSessionTerminal({')
    expect(autoCreateHookSource).toContain('stateRef.current.autoCreatedForWorktree === worktreeId')
    expect(autoCreateHookSource).toContain('stateRef.current.autoCreatedForWorktree = worktreeId')
    expect(autoCreateHookSource).toContain("connState === 'connected'")
    expect(autoCreateHookSource).toContain('(visibleTabCount > 0 || activeHandle !== null)')
    // Why: both callbacks are re-created every render, so the effect must reach them
    // through useEffectEvent rather than deps or a render-time ref write.
    expect(autoCreateHookSource).toContain('useEffectEvent(args.consumeCreationRoute)')
    expect(autoCreateHookSource).toContain('useEffectEvent(args.createTerminal)')
    expect(autoCreateHookSource).toContain('consumeCreationRoute()')
    expect(autoCreateHookSource).toContain('createTerminal()')
  })

  it('arms the auto-create only until the route has published a tab (#9717)', () => {
    // Emptiness after a populated list is a close, not a cold hydrate.
    expect(source).toContain(
      'initialSessionAutoCreateRef.current.sawSessionTabs ||= nextTabs.length > 0'
    )

    const autoCreateCall = sliceBetween(
      'useInitialSessionTerminalAutoCreate({',
      'const connectionVerdict ='
    )
    expect(autoCreateCall).toContain('stateRef: initialSessionAutoCreateRef')
    expect(autoCreateHookSource).toContain('sawSessionTabs: stateRef.current.sawSessionTabs')
  })

  it('delegates stream ownership while retaining the exact terminal polling cadence', () => {
    expect(source).toContain('useMobileSessionTabsReconciliation<')
    expect(source).toContain('const applicationRevision = ++appliedSessionTabsRevisionRef.current')
    expect(source).toContain('getApplicationRevision: getSessionTabsApplicationRevision')
    expect(source).not.toContain("client.subscribe(\n      'session.tabs.subscribe'")
    expect(reconciliationHookSource).toContain("client.subscribe(\n      'session.tabs.subscribe'")
    expect(reconciliationHookSource).toContain(
      "if (AppState.currentState !== 'active') {\n          controller.setReconciliationActive(false)"
    )
    expect(reconciliationHookSource).toContain('void controller.poll()')
    expect(reconciliationHookSource).toContain('void fetchTerminals()')
    expect(reconciliationHookSource).toContain("AppState.addEventListener('change'")
    expect(reconciliationHookSource).toContain('const interval = setInterval(')
    expect(reconciliationHookSource).toContain('2000')
    expect(reconciliationHookSource).toContain('controller.setReconciliationActive(false)')
    expect(reconciliationHookSource).toContain('clearInterval(interval)')
    expect(reconciliationHookSource).toContain('appStateSubscription.remove()')
  })

  it('loads session tabs without waiting for desktop activation', () => {
    const startupEffect = sliceBetween(
      'void (async () => {',
      'return () => {\n      disposed = true'
    )

    expect(startupEffect).toContain("void client\n          .sendRequest('worktree.activate'")
    expect(startupEffect).toContain("if (client && created !== '1' && !isFloatingWorkspaceRoute)")
    expect(startupEffect).toContain("if (client && created === '1' && !isFloatingWorkspaceRoute)")
    expect(startupEffect).toContain('notifyClients: false')
    expect(startupEffect).toContain("navigation: 'caller'")
    expect(startupEffect).not.toContain("await client\n          .sendRequest('worktree.activate'")
    expect(startupEffect.indexOf("sendRequest('worktree.activate'")).toBeLessThan(
      startupEffect.indexOf('await ensureSessionTabs()')
    )
    expect(startupEffect).toContain('headlessActivationNeedsHostRenderer(response.result)')
    expect(startupEffect).toContain("showToast('Open Orca on the host to wake sleeping agents.'")
  })

  it('fails runtime capability gates closed before probing a replacement client', () => {
    const capabilityEffect = sliceBetween(
      'const hostQueryReplyInputSupportedRef = useRef(false)',
      '// Why: read deviceToken from host record'
    )
    const probeStart = capabilityEffect.indexOf('startRuntimeCapabilityProbe(client,')

    expect(probeStart).toBeGreaterThanOrEqual(0)
    for (const reset of [
      'setBrowserScreencastSupported(null)',
      'setAgentSessionHistorySupported(null)',
      'setQuickCommandsSupported(null)',
      'setShowQuickCommands(false)',
      'hostQueryReplyInputSupportedRef.current = false'
    ]) {
      const resetIndex = capabilityEffect.lastIndexOf(reset)
      expect(resetIndex).toBeGreaterThanOrEqual(0)
      expect(resetIndex).toBeLessThan(probeStart)
    }
  })

  it('activates an already-selected pending terminal tab after hydration', () => {
    expect(source).toContain(
      'const pendingTerminalActivationAttemptRef = useRef<string | null>(null)'
    )
    expect(source).toContain('pendingTerminalActivationAttemptRef.current = null')

    const pendingActivationEffect = sliceBetween(
      "if (!client || connState !== 'connected' || !activePendingTerminalTab) {",
      'const showLoadingState ='
    )
    expect(pendingActivationEffect).toContain(
      'pendingTerminalActivationAttemptRef.current === activationKey'
    )
    expect(pendingActivationEffect).toContain('activateMobileSessionTab(client,')
    expect(pendingActivationEffect).toContain('tabId: activePendingTerminalTab.id')
    expect(pendingActivationEffect).toContain('leafId: activePendingTerminalTab.leafId')
    expect(pendingActivationEffect).toContain('notifyClients: false')
    expect(pendingActivationEffect).toContain("navigation: 'caller'")
    expect(pendingActivationEffect).toContain(
      'applySessionTabs((response as RpcSuccess).result as SessionTabsResult)'
    )
    expect(pendingActivationEffect).toContain('scheduleDelayedAction(() => void fetchSessionTabs()')
  })

  it('keeps ready terminal taps local while publishing caller selection', () => {
    const readyTerminalSwitch = sliceBetween(
      'const switchTab = useCallback(',
      'const switchSessionTab = useCallback('
    )

    expect(readyTerminalSwitch).not.toContain('focusMobileTerminal(client, handle)')
    expect(readyTerminalSwitch).toContain('activateMobileSessionTab(client,')
    expect(readyTerminalSwitch).toContain('notifyClients: false')
    expect(readyTerminalSwitch).toContain("navigation: 'caller'")
  })

  it('keeps background and pending session-tab activation local to the phone', () => {
    const activationRequests = source.split('activateMobileSessionTab(client,').slice(1)

    expect(activationRequests).toHaveLength(4)
    for (const request of activationRequests) {
      expect(request.slice(0, request.indexOf('})'))).toContain('notifyClients: false')
      expect(request.slice(0, request.indexOf('})'))).toContain("navigation: 'caller'")
    }
  })

  it('keeps dynamic agent rows above fixed New Tab actions', () => {
    const newTabActions = sliceBetween('title="New Tab"', 'onClose={() => setShowCreateTabDrawer')

    expect(newTabActions.indexOf('...createTabAgentActions')).toBeLessThan(
      newTabActions.indexOf("label: 'Terminal'")
    )
    expect(newTabActions.indexOf("label: 'Terminal'")).toBeLessThan(
      newTabActions.indexOf("label: 'Browser'")
    )
    expect(newTabActions.indexOf("label: 'Browser'")).toBeLessThan(
      newTabActions.indexOf("label: 'Markdown Note'")
    )
  })
})
