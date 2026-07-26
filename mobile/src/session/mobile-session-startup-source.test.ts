import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
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
  it('auto-creates one terminal for an initially empty connected session', () => {
    expect(source).toContain('const initialEmptySessionAutoCreateRef = useRef<string | null>(null)')
    expect(source).toContain('initialEmptySessionAutoCreateRef.current = null')

    const autoCreateEffect = sliceBetween(
      'if (\n      !client ||\n      !showEmptyState',
      'const terminalSummary ='
    )
    expect(autoCreateEffect).toContain('initialEmptySessionAutoCreateRef.current === worktreeId')
    expect(autoCreateEffect).toContain('initialEmptySessionAutoCreateRef.current = worktreeId')
    expect(autoCreateEffect).toContain("setCreateError('')")
    expect(autoCreateEffect).toContain('void handleCreateTerminal()')
  })

  it('stops fallback list polling in the background and reconciles on resume', () => {
    const pollEffect = sliceBetween(
      "const refreshOnForeground = () => {\n        if (AppState.currentState !== 'active')",
      '// Why: pick up Settings → Terminal text size on return'
    )

    expect(pollEffect).toContain(
      "if (AppState.currentState !== 'active') {\n          return\n        }\n        void fetchSessionTabs()"
    )
    expect(pollEffect).toContain('void fetchTerminals()')
    expect(pollEffect).toContain("AppState.addEventListener('change'")
    expect(pollEffect).toContain("if (state === 'active') {\n          refreshOnForeground()")
    expect(pollEffect).toContain('const interval = setInterval(refreshOnForeground, 2000)')
    expect(pollEffect.lastIndexOf('\n      refreshOnForeground()')).toBeGreaterThan(
      pollEffect.indexOf("AppState.addEventListener('change'")
    )
    expect(pollEffect).toContain('clearInterval(interval)')
    expect(pollEffect).toContain('appStateSubscription.remove()')
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
      startupEffect.indexOf('await fetchSessionTabs()')
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
