import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import type { RuntimeWorktreeLifecycleEvent } from '../runtime/orca-runtime-core'
import { DeliveryReceipts, type DeliveryReceiptDb } from './external-conversation-delivery-receipts'
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

/** Host settings own seam lifetime; startup initializes it and later setting changes dispose or recreate it. */
export function installExternalConversations(
  store: ExternalConversationStore | null,
  runtime: {
    getOrchestrationDb: () => DeliveryReceiptDb
    onWorktreeLifecycle: (listener: (event: RuntimeWorktreeLifecycleEvent) => void) => () => void
    subscribeAgentProviderSessionChangesFn:
      | ExternalConversationSeamDeps['onProviderSessionsChanged']
      | null
    agentTransitions: Pick<AgentTransitionDetector, 'latestRow' | 'subscribe'>
  } & ExternalConversationSeamDeps['sessionRows']
): { current(): ExternalConversationSeam | null } {
  if (!store) {
    return { current: () => null }
  }
  // Reuse receipts across enable periods so only previous-process deliveries count as leftovers.
  const receipts = new DeliveryReceipts(() => runtime.getOrchestrationDb())
  let seam: ExternalConversationSeam | null = null
  let reconciled = false
  const reconcile = (): void => {
    reconciled = true
    const enabled = store.getSettings().experimentalConnectors === true
    if (enabled && !seam) {
      seam = new ExternalConversationSeam({
        store,
        readSettings: () => store.getSettings(),
        receipts,
        onWorkspaceRemoved: (listener) =>
          runtime.onWorktreeLifecycle((event) => {
            if (event.kind === 'removed') {
              listener(event.worktreeId)
            }
          }),
        sessionRows: runtime,
        // Without hook session reports, reopening cannot prove which session to resume.
        onProviderSessionsChanged: (listener) =>
          runtime.subscribeAgentProviderSessionChangesFn?.(listener) ?? (() => {}),
        readHookRow: (paneKey) => runtime.agentTransitions.latestRow(paneKey),
        onAgentPaneChange: (listener) => runtime.agentTransitions.subscribe(listener)
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
