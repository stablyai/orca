import { describe, expect, it } from 'vitest'
import {
  readMobileSessionRouteSource,
  readMobileSessionRouteSourceFamily
} from './mobile-session-route-source-family.test-support'

const source = readMobileSessionRouteSourceFamily()
const reconciliationHookSource = readMobileSessionRouteSource(
  './use-mobile-session-tabs-reconciliation.ts'
)
const terminalInventoryRecoverySource = readMobileSessionRouteSource(
  './use-mobile-terminal-inventory-recovery.ts'
)
const terminalStreamPresentationSource = readMobileSessionRouteSource(
  './host-session-terminal-stream-presentation.ts'
)
const autoCreateHookSource = readMobileSessionRouteSource(
  './use-initial-session-terminal-autocreate.ts'
)
const foundationSource = readMobileSessionRouteSource('./use-mobile-session-foundation.ts')
const terminalRuntimeSource = readMobileSessionRouteSource(
  './use-mobile-session-terminal-runtime.ts'
)
const terminalSubscriptionSourceForIdentity = readMobileSessionRouteSource(
  './use-mobile-session-terminal-subscription.ts'
)
const lifecycleSource = readMobileSessionRouteSource('./use-mobile-session-lifecycle.ts')

function sliceBetween(startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('mobile session startup', () => {
  it('auto-creates one terminal for an initially empty connected session', () => {
    expect(source).toContain(
      'const initialSessionAutoCreateRef = useRef(createInitialSessionAutoCreateState())'
    )
    expect(source).toContain(
      'initialSessionAutoCreateRef.current = createInitialSessionAutoCreateState()'
    )
    expect(source).toContain('useInitialSessionTerminalAutoCreate({')
    expect(autoCreateHookSource).toContain('stateRef.current.autoCreatedForWorktree = worktreeId')
    expect(autoCreateHookSource).toContain('createTerminal()')
    expect(source).toContain("setCreateError('')")
    expect(source).toContain('void handleCreateTerminal()')
    expect(source).toContain(
      'const hostedAdapterCreate = !client && sessionTabOperations && !options'
    )
    expect(source).toContain('sessionTabOperations.createAgent(worktreeId, agent)')
    expect(source).toContain('sessionTabOperations.createBlank(worktreeId)')
  })

  it('delegates stream ownership while retaining degraded polling and a certified sweep', () => {
    expect(source).toContain('useMobileSessionTabsReconciliation<')
    expect(source).toContain('const applicationRevision = ++appliedSessionTabsRevisionRef.current')
    expect(source).toContain('getApplicationRevision: getSessionTabsApplicationRevision')
    expect(source).toContain('sessionTabOperations,')
    expect(source).not.toContain("client.subscribe(\n      'session.tabs.subscribe'")
    expect(reconciliationHookSource).toContain(
      "directClient.subscribe(\n      'session.tabs.subscribe'"
    )
    expect(reconciliationHookSource).toContain('sessionTabOperations.snapshot(worktreeId)')
    expect(reconciliationHookSource).toContain('sessionTabOperations.subscribe(')
    expect(reconciliationHookSource).toContain(
      "if (AppState.currentState !== 'active') {\n          suspendTerminalInventoryRecovery(true)"
    )
    expect(reconciliationHookSource).toContain('controller.poll()')
    expect(reconciliationHookSource).toContain('refreshTerminalInventory()')
    expect(reconciliationHookSource).toContain("AppState.addEventListener('change'")
    expect(reconciliationHookSource).toContain('const interval = setInterval(')
    expect(reconciliationHookSource).toContain('RECONCILIATION_INTERVAL_MS = 2000')
    expect(terminalInventoryRecoverySource).toContain('CERTIFIED_TERMINAL_SWEEP_MS = 60_000')
    expect(reconciliationHookSource).toContain('controller.setReconciliationActive(false)')
    expect(reconciliationHookSource).toContain('clearInterval(interval)')
    expect(reconciliationHookSource).toContain('appStateSubscription.remove()')
  })

  it('binds terminal identity to the shared client before subscription effects run', () => {
    // Why: the hosted page has no native client, so identity readiness is a flag rather than a non-null id.
    expect(foundationSource).toContain(
      'const clientId = nativeHostBinding ? nativeHost.clientId : null'
    )
    expect(foundationSource).toContain(
      'const hostClientIdentityReady = !nativeHostBinding || clientId !== null'
    )
    expect(foundationSource).toContain('    clientId,')
    expect(terminalRuntimeSource).toContain('useRef<string | null>(clientId)')
    expect(terminalRuntimeSource).toContain('deviceTokenRef.current = clientId')
    expect(terminalRuntimeSource).toContain(
      'inputGate.canSend && sessionTerminalOperations != null && hostClientIdentityReady'
    )
    expect(terminalSubscriptionSourceForIdentity).toContain('if (!hostClientIdentityReady)')
    expect(terminalSubscriptionSourceForIdentity).toContain(
      'terminalId: handle,\n          clientId,'
    )
    expect(lifecycleSource).not.toContain('deviceTokenRef.current = host.deviceToken')
  })

  it('confirms terminal stream teardown with a committed inventory-recovery bridge', () => {
    expect(terminalStreamPresentationSource).toContain(
      "if (data.type === 'end' || data.type === 'error')"
    )
    expect(source).toContain('signalTerminalInventoryRecovery()')
    expect(terminalInventoryRecoverySource).toContain('actionRef.current = recoveryAction')
    expect(terminalInventoryRecoverySource).toContain('pendingSignalScopeRef.current = scopeKey')
    expect(terminalInventoryRecoverySource).toContain(
      'committedScope !== null && committedScope !== scopeKey'
    )
    expect(source).toContain('return terminalInventoryRequest.activate()')
    expect(source).toContain('if (!isCurrent() || !response.ok)')
    expect(terminalInventoryRecoverySource).toContain(
      'TERMINAL_INVENTORY_CONFIRMATION_DELAY_MS = 750'
    )
    expect(terminalInventoryRecoverySource).toContain(
      'refreshTerminalInventory({ allowEmptyLoaded: true })'
    )
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

  it('fails runtime capability gates closed while probing a replacement client', () => {
    const capabilityEffect = sliceBetween(
      'const [runtimeCapabilitySnapshot, setRuntimeCapabilitySnapshot]',
      '// Why: the shared client owns authenticated identity'
    )
    const probeStart = capabilityEffect.indexOf('startRuntimeCapabilityRead(')

    expect(probeStart).toBeGreaterThanOrEqual(0)
    expect(capabilityEffect).toContain('sessionTabOperations.runtimeCapabilities()')
    expect(capabilityEffect).toContain(
      "connState === 'connected' && runtimeCapabilitySnapshot?.operations === sessionTabOperations"
    )
    expect(capabilityEffect).toContain('setRuntimeCapabilitySnapshot({')
    const resetIndex = capabilityEffect.lastIndexOf(
      'hostQueryReplyInputSupportedRef.current = false'
    )
    expect(resetIndex).toBeGreaterThanOrEqual(0)
    expect(resetIndex).toBeLessThan(probeStart)
  })

  it('activates an already-selected pending terminal tab after hydration', () => {
    expect(source).toContain(
      'const pendingTerminalActivationAttemptRef = useRef<string | null>(null)'
    )
    expect(source).toContain('pendingTerminalActivationAttemptRef.current = null')

    const pendingActivationEffect = sliceBetween(
      "if (!sessionTabOperations || connState !== 'connected' || !activePendingTerminalTab) {",
      'const showLoadingState ='
    )
    expect(pendingActivationEffect).toContain(
      'pendingTerminalActivationAttemptRef.current === activationKey'
    )
    expect(pendingActivationEffect).toContain(
      'activateSessionTab(activePendingTerminalTab.id, activePendingTerminalTab.leafId)'
    )
    expect(pendingActivationEffect).toContain('scheduleDelayedAction(() => void fetchSessionTabs()')
  })

  it('keeps ready terminal taps local while publishing caller selection', () => {
    const readyTerminalSwitch = sliceBetween(
      'const switchTab = useCallback(',
      'const switchSessionTab = useCallback('
    )

    expect(readyTerminalSwitch).not.toContain('focusMobileTerminal(client, handle)')
    expect(readyTerminalSwitch).toContain('activateSessionTab(matchingTab.id)')
  })

  it('opens the unchanged setup sheet for synchronous dictation setup failures', () => {
    const startDictation = sliceBetween(
      'const startDictation = useCallback(',
      'const cancelDictation = useCallback('
    )

    expect(startDictation).toContain('isDictationSetupRequiredError(message)')
    expect(startDictation).toContain('setShowDictationSetup(true)')
  })

  it('routes every session-tab activation through the named platform boundary', () => {
    expect(source.match(/activateSessionTab\(/g)).toHaveLength(4)
    expect(source).not.toContain("sendRequest('session.tabs.activate'")
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
    expect(newTabActions).toContain("label: 'Browser',\n                  closeBeforePress: true")
  })

  it('wires pending-handle recovery through its bounded context (STA-4256)', () => {
    const applySessionTabs = sliceBetween(
      'const applySessionTabs = useCallback(',
      'const consumeAcceptedSessionTabs = useCallback('
    )
    const recoveryContext = sliceBetween(
      'const pendingTerminalRecoveryContextCache = useMemo(',
      'const sessionTabsFetchReporting'
    )

    const tabsRefWrite = 'sessionTabsRef.current = nextTabs'
    const tabsStateWrite = 'setSessionTabs((prev)'
    const activeRefWrite = 'activeSessionTabIdRef.current = active?.id ?? null'
    const activeStateWrite = 'setActiveSessionTabId(active?.id ?? null)'
    for (const write of [tabsRefWrite, tabsStateWrite, activeRefWrite, activeStateWrite]) {
      expect(applySessionTabs).toContain(write)
    }
    expect(applySessionTabs.indexOf(tabsRefWrite)).toBeLessThan(
      applySessionTabs.indexOf(tabsStateWrite)
    )
    expect(applySessionTabs.indexOf(activeRefWrite)).toBeLessThan(
      applySessionTabs.indexOf(activeStateWrite)
    )
    expect(recoveryContext).toContain('() => new PendingTerminalHandleRecoveryContextCache()')
    expect(recoveryContext).toContain('sessionTabsRef.current,')
    expect(recoveryContext).toContain('activeSessionTabIdRef.current')
    expect(recoveryContext).toContain(
      'const pendingTerminalRecoveryContextKey = getPendingTerminalRecoveryContextKey()'
    )
    expect(source).toContain('hasRecoveryNeed: hasSessionTabsRecoveryNeed')
    expect(source).toContain('getPendingTerminalRecoveryContextKey,')
    expect(source).toContain('onPendingTerminalRecoveryParked: setParkedPendingTerminalContext')
    expect(source).toContain('retryPendingTerminalRecovery()')
  })
})
