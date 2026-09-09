// Shared types cho Workflow (TDD-FE-14)

// FE-TASK-004: renamed from 'notify' to match backend StepType (agent|shell|notification|
// webhook|condition; step.go:16-23). 'approval' has no backend equivalent — kept until
// product confirms removal (see FE-TASK-004's task doc); do not remove without that sign-off.
export type WorkflowStepType =
  | 'agent'
  | 'shell'
  | 'notification'
  | 'webhook'
  | 'condition'
  | 'approval'
export type WorkflowScope = 'personal' | 'project' | 'company'

export type AgentStepConfig = {
  type: 'agent'
  prompt: string
  model?: string
  worktreePath: string
}

export type ShellStepConfig = {
  type: 'shell'
  command: string
  args?: string[]
  cwd?: string
}

export type NotifyStepConfig = {
  type: 'notification'
  message: string
  channel: 'slack' | 'email' | 'webhook'
  target: string
}

export type WorkflowStep = {
  id: string
  type: WorkflowStepType
  name: string
  serverSpec: string
  config: AgentStepConfig | ShellStepConfig | NotifyStepConfig
  dependsOn: string[]
  continueOnError: boolean
  timeout: number
}

export type WorkflowDefinition = {
  id: string
  name: string
  templateId?: string
  scope: WorkflowScope
  scopeRefId?: string
  steps: WorkflowStep[]
}

export type WorkflowExecutionStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export type WorkflowExecution = {
  id: string
  templateId: string
  status: WorkflowExecutionStatus
  startedAt: number
  endedAt?: number
  triggeredBy: string
  definition: WorkflowDefinition
  /** Span id của `ui:workflow.execute` (FE) == `workflow:execute` (BE, nếu resume đúng).
   *  Dùng để filter TracePanel theo toàn bộ execution. */
  rootTraceId?: string
}
