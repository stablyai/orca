import type { MountAdapter } from '../recording-scenario'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKTREE = 'id:workspace-1'
const TERMINAL = 'terminal-1'
const TAB = 'tab-1'

/**
 * Making a session tab the active one, and the reconciliation loop that keeps the tab list honest.
 *
 * The activation pair is recorded because of its one retry: a logical cutover is replayed once, so
 * a golden has to show two sender calls for one action and a non-cutover error showing one. The
 * stream-health controller is recorded for the opposite reason — its generation, barrier and
 * application-revision guards each drop a reply, and only a recording says which drop happened.
 */
export function sessionTabMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.tab-activation': ({ client }) => {
      const activation = modules.load<
        typeof import('../../../session/mobile-session-tab-activation')
      >('mobile/src/session/mobile-session-tab-activation.ts')
      const replies: Record<string, unknown> = {}
      let failure: unknown = null
      return {
        action: (name) =>
          (name === 'focus'
            ? activation.focusMobileTerminal(client, TERMINAL)
            : activation.activateMobileSessionTab(client, {
                worktree: WORKTREE,
                tabId: TAB,
                notifyClients: false,
                navigation: 'caller',
                intent: 'user'
              })
          ).then(
            (value: unknown) => {
              replies[name] = value
              return value
            },
            (error: unknown) => {
              failure = error instanceof Error ? error.message : String(error)
              throw error
            }
          ),
        state: () => ({ ...replies, failure }),
        dispose: () => {}
      }
    },
    'session.tabs-stream-health': ({ client, effect }) => {
      const Controller = modules.load<
        typeof import('../../../session/mobile-session-tabs-stream-health')
      >('mobile/src/session/mobile-session-tabs-stream-health.ts').MobileSessionTabsStreamHealth
      let applicationRevision = 0
      let accepted: unknown = 'unapplied'
      let rejectApply = false
      const controller = new Controller<{ tabs?: readonly { id: string }[] }, { id: string }>(
        mountFixture<
          ConstructorParameters<
            typeof Controller<{ tabs?: readonly { id: string }[] }, { id: string }>
          >[0]
        >({
          client,
          scope: WORKTREE,
          apply: (result) =>
            rejectApply
              ? { accepted: false }
              : { accepted: true, effectiveTabs: result.tabs ?? [], applicationRevision },
          consumeAccepted: (_result, effectiveTabs, source) => {
            accepted = { tabs: effectiveTabs, source }
          },
          hasRecoveryNeed: () => false,
          getApplicationRevision: () => applicationRevision,
          onFetchStarted: () => effect('fetch-started', {}),
          onFetchSucceeded: (result) => effect('fetch-succeeded', result),
          onFetchFailed: (failure) => effect('fetch-failed', failure.error),
          onFetchErrored: (error) =>
            effect('fetch-errored', error instanceof Error ? error.message : String(error))
        })
      )
      return {
        action(name) {
          if (name === 'activate') {
            // Nothing is fetched until the screen turns reconciliation on; the class starts off.
            controller.setReconciliationActive(true)
            return true
          }
          if (name === 'reconcile') {
            return controller.requestReconciliation()
          }
          if (name === 'retry') {
            return controller.retryReconciliation()
          }
          if (name === 'revise') {
            applicationRevision += 1
            return applicationRevision
          }
          if (name === 'reject-apply') {
            rejectApply = true
            return rejectApply
          }
          throw new Error(`Unknown session tabs health action: ${name}`)
        },
        state: () => ({ accepted, applicationRevision }),
        dispose: () => controller.dispose()
      }
    }
  }
}
