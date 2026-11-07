import { hookMount } from '../hook-mount'
import { mountFixture } from '../recorder-fixture-shape'
import type { MobileSessionTab } from '../../../session/mobile-session-route-types'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

const HOST_ID = 'host-1'

// Record callback effects and flags; scenario-declared tab-load rejection tests whether later terminal loads survive.
// Consume created on the same mount to reach both mutually exclusive activation sites through the real effect rerun.
// `host-tabs` stands in for an accepted host snapshot (revision bump, then the strip); `leave` keeps the document's cache for a reopen.
export function sessionStartupMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.startup': ({ client, effect }) => {
      const useStartup = modules.load<typeof import('../../../session/use-mobile-session-startup')>(
        'mobile/src/session/use-mobile-session-startup.ts'
      ).useMobileSessionStartup

      let created: string | undefined
      let worktreeId = 'wt-1'
      let isFloatingWorkspaceRoute = false
      let tabLoadRejects = false
      let terminalsLoaded = true
      let activeHandle: string | null = 'terminal-0'
      const activeHandleRef: { current: string | null } = { current: 'terminal-0' }
      const initializedHandlesRef = { current: new Set<string>() }
      const appliedSnapshotMarkerRef = { current: { epoch: 'epoch-0', version: 7 } }
      const closedTabTombstonesRef = { current: new Map<string, number>() }
      const terminalGestureInputQueuesRef = { current: new Map<string, never>() }
      const terminalGestureInputInFlightRef = { current: new Set<string>() }
      const sessionTabActionSheetRequestSeqRef = { current: 0 }
      let sessionTabs: MobileSessionTab[] = []
      const appliedSessionTabsRevisionRef = { current: 0 }
      // Stable like the screen's own callbacks, so an update reruns the route reset only when the route changes.
      const routeResetDeps = {
        setSplitTerminalHandles: () => {},
        terminalPaneViewportsRef: { current: new Map() },
        clearPendingLiveInputCommit: () => effect('clear-pending-live-input-commit', {}),
        clearDelayedActionTimers: () => effect('clear-delayed-action-timers', {}),
        clearTerminalCache: () => effect('clear-terminal-cache', {})
      }

      const hook = hookMount(() => {
        useStartup(
          mountFixture<Parameters<typeof useStartup>[0]>({
            ...routeResetDeps,
            hostId: HOST_ID,
            worktreeId,
            created,
            isFloatingWorkspaceRoute,
            connState: 'connected',
            client,
            setTerminals: () => {},
            terminalsRef: { current: [] },
            sessionTabs,
            setSessionTabs: (update) => {
              sessionTabs = typeof update === 'function' ? update(sessionTabs) : update
            },
            appliedSessionTabsRevisionRef,
            appliedSnapshotMarkerRef,
            closedTabTombstonesRef,
            setTerminalsLoaded: (value: boolean) => {
              terminalsLoaded = value
            },
            setActiveHandle: (update) => {
              activeHandle = typeof update === 'function' ? update(activeHandle) : update
            },
            setActiveSessionTabId: () => {},
            setMarkdownDocs: () => {},
            setFileDocs: () => {},
            terminalGestureInputQueuesRef,
            terminalGestureInputInFlightRef,
            sessionTabActionSheetKeyboardHideSubRef: { current: null },
            sessionTabActionSheetRequestSeqRef,
            initializedHandlesRef,
            terminalDiagnosticsRef: {
              current: { resetRoute: () => effect('diagnostics-reset-route', {}) }
            },
            activeHandleRef,
            activeSessionTabTypeRef: { current: 'terminal' },
            pendingSelectionRef: { current: null },
            selectedSessionTabIdRef: { current: null },
            pendingBrowserFocusPageIdRef: { current: null },
            pendingTerminalActivationAttemptRef: { current: null },
            initialSessionAutoCreateRef: { current: null },
            showToast: (message: string, durationMs?: number) =>
              effect('toast', { message, durationMs: durationMs ?? null }),
            fetchTerminals: async (options) => {
              effect('fetch-terminals', { allowEmptyLoaded: options?.allowEmptyLoaded ?? null })
              return true
            },
            ensureSessionTabs: async () => {
              effect('ensure-session-tabs', {})
              if (tabLoadRejects) {
                throw new Error('Could not load session tabs')
              }
            }
          })
        )
      })

      return {
        action(name, args) {
          if (name === 'mount') {
            created = args.created === undefined ? undefined : String(args.created)
            isFloatingWorkspaceRoute = args.floating === true
            tabLoadRejects = args.tabLoadRejects === true
            for (const handle of Array.isArray(args.initialized) ? args.initialized : []) {
              initializedHandlesRef.current.add(String(handle))
            }
            return hook.mount()
          }
          if (name === 'consume-created-route') {
            // Clear created as real auto-create does so the mounted effect reruns through the ordinary activation branch.
            created = undefined
            return hook.update()
          }
          if (name === 'host-tabs') {
            const ids = Array.isArray(args.tabs) ? args.tabs.map(String) : []
            appliedSessionTabsRevisionRef.current += 1
            sessionTabs = ids.map((id) =>
              mountFixture<Extract<MobileSessionTab, { type: 'terminal' }>>({
                id,
                type: 'terminal',
                title: id,
                terminal: id
              })
            )
            return hook.update()
          }
          if (name === 'switch-worktree') {
            // A reused route: same screen, next workspace.
            worktreeId = String(args.worktree)
            return hook.update()
          }
          if (name === 'leave') {
            return hook.leave()
          }
          if (name === 'unmount') {
            return hook.unmount()
          }
          throw new Error(`Unknown session startup action: ${name}`)
        },
        state: () => ({
          sessionTabs: sessionTabs.map((tab) => tab.id),
          terminalsLoaded,
          activeHandle,
          initializedHandles: [...initializedHandlesRef.current].sort(),
          appliedSnapshotMarker: appliedSnapshotMarkerRef.current,
          closedTabTombstones: closedTabTombstonesRef.current.size,
          actionSheetRequestSeq: sessionTabActionSheetRequestSeqRef.current
        }),
        dispose: hook.unmount
      }
    }
  }
}
