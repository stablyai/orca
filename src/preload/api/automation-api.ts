import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchRequest,
  AutomationDispatchResult,
  ExternalAutomationCreateInput,
  ExternalAutomationActionInput,
  ExternalAutomationManager,
  ExternalAutomationRunsInput,
  ExternalAutomationRunsPage,
  ExternalAutomationUpdateInput,
  AutomationRun,
  AutomationPrecheckResult,
  AutomationUpdateInput
} from '../../shared/automations-types'

export type AutomationsApi = {
  list: () => Promise<Automation[]>
  listRuns: (args?: { automationId?: string }) => Promise<AutomationRun[]>
  listExternalManagers: () => Promise<ExternalAutomationManager[]>
  listExternalRuns: (input: ExternalAutomationRunsInput) => Promise<ExternalAutomationRunsPage>
  createExternal: (input: ExternalAutomationCreateInput) => Promise<void>
  updateExternal: (input: ExternalAutomationUpdateInput) => Promise<void>
  runExternalAction: (input: ExternalAutomationActionInput) => Promise<void>
  create: (input: AutomationCreateInput) => Promise<Automation>
  update: (args: { id: string; updates: AutomationUpdateInput }) => Promise<Automation>
  delete: (args: { id: string }) => Promise<void>
  runNow: (args: { id: string }) => Promise<AutomationRun>
  runPrecheck: (args: {
    automationId: string
    runId: string
  }) => Promise<AutomationPrecheckResult | null>
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
  snapshotWorkspaceName: (args: { workspaceId: string; displayName: string }) => Promise<number>
  rendererReady: () => Promise<void>
  onDispatchRequested: (callback: (request: AutomationDispatchRequest) => void) => () => void
}
