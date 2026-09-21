import { hookMount } from '../hook-mount'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

const WORKTREE_ID = 'wt-1'
const HOST_ID = 'host-1'

/**
 * The session route's startup effect: the host-side activation it announces, and the tab and
 * terminal loads it sequences behind it.
 *
 * Nothing here touches a WebView ref. `ensureSessionTabs`, `fetchTerminals` and `clearTerminalCache`
 * are scope callbacks, so they record as effects — `fetchTerminals` carrying the
 * `allowEmptyLoaded` flag each pass was given, which is what makes the delayed passes distinguishable
 * from the awaited one and from each other.
 *
 * A scenario may also declare that the tab load fails. The stub still records the call it was asked
 * for and then rejects, which is the one thing a scope callback can do that a resolving stub cannot
 * express: the sequence awaits that promise, so whether the terminal loads behind it survive a
 * refused tab load is a product decision no scenario could otherwise reach. Declared, not shaped —
 * the rejection is the scenario's, and the stub neither builds a param nor swallows a throw.
 *
 * Both `worktree.activate` sends live in this one effect and neither is awaited by the sequence: the
 * plain one races the tab load deliberately, and the newly-created one is a timer the effect arms
 * only while the route still carries `created=1`. `created` and the floating-route flag are
 * scenario-declared, because which of the two sites exists at all is what they decide.
 *
 * They are mutually exclusive per pass, so one scenario reaches both only the way the product does:
 * the auto-create clears `created` off the route once it has run, the effect re-runs on the same
 * mount, and the second pass takes the other branch. That is what `consume-created-route` is, and it
 * is what lets the reply matrix drive both sites rather than only the first scenario's.
 *
 * State is the route reset the first effect performs and the loading flag the second one clears,
 * because the sends themselves publish nothing: the only thing read off an activation reply is the
 * sleeping-agent toast, and that lands in the effects.
 */
export function sessionStartupMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.startup': ({ client, effect }) => {
      const useStartup = modules.load<typeof import('../../../session/use-mobile-session-startup')>(
        'mobile/src/session/use-mobile-session-startup.ts'
      ).useMobileSessionStartup

      let created: string | undefined
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

      const hook = hookMount(() => {
        useStartup(
          mountFixture<Parameters<typeof useStartup>[0]>({
            hostId: HOST_ID,
            worktreeId: WORKTREE_ID,
            created,
            isFloatingWorkspaceRoute,
            connState: 'connected',
            client,
            setTerminals: () => {},
            terminalsRef: { current: [] },
            setSessionTabs: () => {},
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
            pendingActiveSessionTabIdRef: { current: null },
            selectedSessionTabIdRef: { current: null },
            pendingActiveTerminalHandleRef: { current: null },
            pendingBrowserFocusPageIdRef: { current: null },
            pendingTerminalActivationAttemptRef: { current: null },
            initialSessionAutoCreateRef: { current: null },
            bufferedTerminalDraftState: {
              resetDrafts: () => effect('reset-drafts', {}),
              clearPendingRestorations: () => effect('clear-pending-restorations', {})
            },
            clearPendingLiveInputCommit: () => effect('clear-pending-live-input-commit', {}),
            clearDelayedActionTimers: () => effect('clear-delayed-action-timers', {}),
            showToast: (message: string, durationMs?: number) =>
              effect('toast', { message, durationMs: durationMs ?? null }),
            clearTerminalCache: () => effect('clear-terminal-cache', {}),
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
            // Which of the two activation sites exists is the scenario's declaration, not this stub's.
            created = args.created === undefined ? undefined : String(args.created)
            isFloatingWorkspaceRoute = args.floating === true
            tabLoadRejects = args.tabLoadRejects === true
            for (const handle of Array.isArray(args.initialized) ? args.initialized : []) {
              initializedHandlesRef.current.add(String(handle))
            }
            return hook.mount()
          }
          if (name === 'consume-created-route') {
            // What the auto-create does on a fresh workspace: `router.setParams({ created:
            // undefined })` on the mounted screen, which re-runs the effect down its other branch.
            created = undefined
            return hook.update()
          }
          if (name === 'unmount') {
            return hook.unmount()
          }
          throw new Error(`Unknown session startup action: ${name}`)
        },
        state: () => ({
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
