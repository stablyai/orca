import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RuntimeWorktreeLifecycleEvent } from '../runtime/orca-runtime-core'
import type { DeliveryReceiptDb } from './external-conversation-delivery-receipts'
import type { ExternalConversationLinkStore } from './external-conversation-links'
import {
  ExternalConversationSeam,
  type ExternalConversationSeamDeps
} from './external-conversation-seam'

export type ExternalConversationStore = ExternalConversationLinkStore & {
  getSettings: () => Partial<
    Pick<GlobalSettings, 'experimentalConnectors' | 'agentStatusHooksEnabled' | 'disabledTuiAgents'>
  >
  onSettingsChanged?: (listener: (updates: Partial<GlobalSettings>) => void) => unknown
}

/**
 * Owns the seam's lifetime, on the settings-change pattern `installStructuredAgentAvailability`
 * uses: one exists exactly while `experimentalConnectors` is on. The flag is
 * first read on the first `current()`, which each runtime host makes at startup so an enabled
 * seam watches its links from then; a change after that disposes or rebuilds the seam. The host is the
 * authority, so every connector entry point asks it rather than its caller's profile.
 */
export function installExternalConversations(
  store: ExternalConversationStore | null,
  runtime: {
    getOrchestrationDb: () => DeliveryReceiptDb
    onWorktreeLifecycle: (listener: (event: RuntimeWorktreeLifecycleEvent) => void) => () => void
    subscribeAgentProviderSessionChangesFn:
      | ExternalConversationSeamDeps['onProviderSessionsChanged']
      | null
  } & ExternalConversationSeamDeps['sessionRows']
): { current(): ExternalConversationSeam | null } {
  if (!store) {
    return { current: () => null }
  }
  let seam: ExternalConversationSeam | null = null
  let reconciled = false
  const reconcile = (): void => {
    reconciled = true
    const enabled = store.getSettings().experimentalConnectors === true
    if (enabled && !seam) {
      seam = new ExternalConversationSeam({
        store,
        readSettings: () => store.getSettings(),
        receiptDb: () => runtime.getOrchestrationDb(),
        onWorkspaceRemoved: (listener) =>
          runtime.onWorktreeLifecycle((event) => {
            if (event.kind === 'removed') {
              listener(event.worktreeId)
            }
          }),
        sessionRows: runtime,
        // A host without a hook store reports no sessions; reopen then refuses for want of one.
        onProviderSessionsChanged: (listener) =>
          runtime.subscribeAgentProviderSessionChangesFn?.(listener) ?? (() => {})
      })
    } else if (!enabled && seam) {
      seam.dispose('connectors_disabled')
      seam = null
    }
  }
  store.onSettingsChanged?.((updates) => {
    if ('experimentalConnectors' in updates) {
      reconcile()
    }
  })
  return {
    current: () => {
      if (!reconciled) {
        reconcile()
      }
      return seam
    }
  }
}
