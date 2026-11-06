import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  AutomationDispatchRequest,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun,
  ExternalAutomationManager
} from '../../shared/automations-types'
import type { AutomationOwnerRef } from '../../shared/automation-owner-ref'
import type {
  ScopedExternalManagerActionRequest,
  ScopedExternalManagerListRequest
} from '../../shared/external-automation-scope'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'

export type ExternalAutomationManagerResult = {
  /** Null once a probe succeeded and found no manager configured for this scope. */
  manager: ExternalAutomationManager | null
  error: string | null
  updatedAt: number
}

// Automation CRUD uses runtime RPC; this IPC API handles desktop probes and dispatch.
export type AutomationsApi = {
  listExternalManagerForOwner: (
    request: ScopedExternalManagerListRequest
  ) => Promise<ExternalAutomationManagerResult>
  runExternalActionForOwner: (request: ScopedExternalManagerActionRequest) => Promise<void>
  retainExternalScopes: (request: { owners: readonly AutomationOwnerRef[] }) => Promise<void>
  runPrecheck: (args: {
    automationId: string
    runId: string
  }) => Promise<AutomationPrecheckResult | null>
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
  snapshotWorkspaceName: (args: {
    workspaceId: string
    hostId: ExecutionHostId
    displayName: string
  }) => Promise<number>
  rendererReady: () => Promise<void>
  onDispatchRequested: (callback: (request: AutomationDispatchRequest) => void) => () => void
  onChanged: (callback: (payload: AutomationsChangedPayload) => void) => () => void
}
