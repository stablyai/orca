import { hookMount } from '../hook-mount'
import { mountFixture } from '../recorder-fixture-shape'
import type { MobileSessionTab } from '../../../session/tabs/mobile-session-tabs'
import type * as MobileSessionLastTabsModule from '../../../session/tabs/mobile-session-last-tabs'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

const HOST_ID = 'host-1'

// Record callback effects and flags; scenario-declared tab-load rejection tests whether later terminal loads survive.
// Consume created on the same mount to reach both mutually exclusive activation sites through the real effect rerun.
// `host-tabs` stands in for an accepted host snapshot (remembered as the screen's controller does, then drawn); `leave` keeps the document's cache for a reopen.
export function sessionStartupMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.startup': ({ client, effect }) => {
      const useStartup = modules.load<typeof import('../../../session/use-mobile-session-startup')>(
        'mobile/src/session/use-mobile-session-startup.ts'
      ).useMobileSessionStartup
      const useLastTabs = modules.load<typeof MobileSessionLastTabsModule>(
        'mobile/src/session/tabs/mobile-session-last-tabs.ts'
      ).useMobileSessionLastTabs

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
      let lastTabs: ReturnType<typeof useLastTabs> | undefined
      // Stable like the screen's own callbacks, so an update reruns the route reset only when the route changes.
      const routeResetDeps = {
        setSplitTerminalHandles: () => {},
        terminalPaneViewportsRef: { current: new Map() },
        clearPendingLiveInputCommit: () => effect('clear-pending-live-input-commit', {}),
        clearDelayedActionTimers: () => effect('clear-delayed-action-timers', {}),
        clearTerminalCache: () => effect('clear-terminal-cache', {}),
        terminalResume: { holdsAny: () => false, anyCatchingUp: () => false }
      }

      const hook = hookMount(() => {
        lastTabs = useLastTabs(HOST_ID, worktreeId)
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
            setSessionTabs: (update) => {
              sessionTabs = typeof update === 'function' ? update(sessionTabs) : update
            },
            readLastSessionTabs: lastTabs.readLastSessionTabs,
            watchLastSessionTabs: lastTabs.watchLastSessionTabs,
            sessionTabsRef: { current: sessionTabs },
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
            sessionTabs = ids.map((id) =>
              mountFixture<Extract<MobileSessionTab, { type: 'terminal' }>>({
                id,
                type: 'terminal',
                title: id,
                terminal: id
              })
            )
            lastTabs?.rememberLastSessionTabs(sessionTabs)
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
