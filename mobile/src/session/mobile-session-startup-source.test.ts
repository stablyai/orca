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

  it('loads session tabs without waiting for desktop activation', () => {
    const startupEffect = sliceBetween(
      'void (async () => {',
      'return () => {\n      disposed = true'
    )

    expect(startupEffect).toContain("void client\n          .sendRequest('worktree.activate'")
    expect(startupEffect).toContain('notifyClients: false')
    expect(startupEffect).not.toContain("await client\n          .sendRequest('worktree.activate'")
    expect(startupEffect.indexOf("sendRequest('worktree.activate'")).toBeLessThan(
      startupEffect.indexOf('await fetchSessionTabs()')
    )
    expect(startupEffect).toContain('headlessActivationNeedsHostRenderer(response.result)')
    expect(startupEffect).toContain("showToast('Open Orca on the host to wake sleeping agents.'")
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
    expect(pendingActivationEffect).toContain("sendRequest('session.tabs.activate'")
    expect(pendingActivationEffect).toContain('tabId: activePendingTerminalTab.id')
    expect(pendingActivationEffect).toContain('leafId: activePendingTerminalTab.leafId')
    expect(pendingActivationEffect).toContain('notifyClients: false')
    expect(pendingActivationEffect).toContain(
      'applySessionTabs((response as RpcSuccess).result as SessionTabsResult)'
    )
    expect(pendingActivationEffect).toContain('scheduleDelayedAction(() => void fetchSessionTabs()')
  })

  it('keeps mobile session tab activation local to the phone', () => {
    const activationRequests = source.split("sendRequest('session.tabs.activate'").slice(1)

    expect(activationRequests).toHaveLength(4)
    for (const request of activationRequests) {
      expect(request.slice(0, request.indexOf('})'))).toContain('notifyClients: false')
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
