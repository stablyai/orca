import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useMobileSessionTabApplication } from './use-mobile-session-tab-application'
import type { MobileSessionTerminalListModel } from './use-mobile-session-terminal-list'
import type { SessionTabsResult } from './mobile-session-route-types'

function scope() {
  const ref = <T>(current: T) => ({ current })
  return {
    hostId: 'host-a',
    worktreeId: 'workspace-a',
    sessionTabOperations: { activate: vi.fn() },
    setWorkspaceTransportState: vi.fn(),
    setTerminals: vi.fn(),
    terminalsRef: ref([]),
    setSessionTabs: vi.fn(),
    sessionTabsRef: ref([]),
    appliedSnapshotMarkerRef: ref({ epoch: null, version: -1 }),
    appliedSessionTabsRevisionRef: ref(0),
    closedTabTombstonesRef: ref(new Map()),
    reconcileBufferedDraftsRef: ref(vi.fn()),
    setTerminalsLoaded: vi.fn(),
    defaultTerminalHandlesToLiveInput: vi.fn(),
    setActiveHandle: vi.fn(),
    setActiveSessionTabId: vi.fn(),
    activeSessionTabIdRef: ref(null),
    selectedSessionTabIdRef: ref(null),
    markdownDocsRef: ref(new Map()),
    initializedHandlesRef: ref(new Set()),
    terminalDiagnosticsRef: ref({ tabsApplied: vi.fn() }),
    activeHandleRef: ref(null),
    activeSessionTabTypeRef: ref(null),
    pendingActiveSessionTabIdRef: ref(null),
    pendingActiveTerminalHandleRef: ref(null),
    pendingBrowserFocusPageIdRef: ref(null),
    initialSessionAutoCreateRef: ref({ sawSessionTabs: false }),
    unsubscribeTerminal: vi.fn(),
    subscribeToTerminal: vi.fn(),
    lastKnownTerminalCountRef: ref(0),
    setFileDocs: vi.fn(),
    setMarkdownDocs: vi.fn(),
    fileDocLifecycleRef: ref({ reconcile: vi.fn() }),
    markdownDocLifecycleRef: ref({ reconcile: vi.fn() })
  }
}

describe('session tab activation source ownership', () => {
  it.each(['workspace', 'host', 'operations', 'unmount', 'unchanged'] as const)(
    'handles a delayed activation after %s changes',
    async (change) => {
      const initial = scope()
      let resolveActivation: (snapshot: SessionTabsResult) => void = () => {}
      initial.sessionTabOperations.activate.mockReturnValue(
        new Promise<SessionTabsResult>((resolve) => {
          resolveActivation = resolve
        })
      )
      let actions: ReturnType<typeof useMobileSessionTabApplication> | undefined
      function Harness({ value }: { value: typeof initial }) {
        actions = useMobileSessionTabApplication(value as unknown as MobileSessionTerminalListModel)
        return null
      }
      let renderer: ReturnType<typeof create> | undefined
      try {
        act(() => {
          renderer = create(createElement(Harness, { value: initial }))
        })
        const activation = actions!.activateSessionTab('tab-a')
        act(() => {
          if (change === 'unmount') {
            renderer?.unmount()
          } else {
            renderer?.update(
              createElement(Harness, {
                value: {
                  ...initial,
                  ...(change === 'workspace' ? { worktreeId: 'workspace-b' } : {}),
                  ...(change === 'host' ? { hostId: 'host-b' } : {}),
                  ...(change === 'operations'
                    ? { sessionTabOperations: { activate: vi.fn() } }
                    : {})
                }
              })
            )
          }
        })
        const snapshot = {
          snapshotVersion: 1,
          tabs: [],
          activeTabId: null
        } as unknown as SessionTabsResult
        await act(async () => {
          resolveActivation(snapshot)
          await activation
        })
        expect(initial.setSessionTabs).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0)
        expect(initial.setWorkspaceTransportState).toHaveBeenCalledTimes(
          change === 'unchanged' ? 1 : 0
        )
        expect(await activation).toBe(change === 'unchanged')
      } finally {
        act(() => renderer?.unmount())
      }
    }
  )
})
