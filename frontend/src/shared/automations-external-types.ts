// Types for externally-managed automation providers (Hermes/OpenClaw cron
// jobs) — a separate domain from this project's own Automation/AutomationRun
// (CR-AUTO-*'s action-chain model). Split out of automations-types.ts to
// keep that file under AGENTS.md's max-lines limit (see
// specs/frontend/crs/v4/automation/tasks/FE-TASK-AUTO-006's "Kết quả thực
// tế" — the split became necessary once FE-TASK-AUTO-002's action-chain
// types and FE-TASK-AUTO-006's trigger type both landed there).

export type ExternalAutomationProvider = 'hermes' | 'openclaw'
export type ExternalAutomationManagerStatus = 'available' | 'unavailable'
export type ExternalAutomationAction = 'pause' | 'resume' | 'run' | 'delete'
export type ExternalAutomationRunStatus = 'completed' | 'failed' | 'unknown'

export type ExternalAutomationTarget =
  | {
      type: 'local'
    }
  | {
      type: 'ssh'
      connectionId: string
    }

export type ExternalAutomationJob = {
  id: string
  managerId: string
  provider: ExternalAutomationProvider
  name: string
  schedule: string
  rawSchedule: string | null
  enabled: boolean
  state: string
  prompt: string | null
  promptPreview: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  lastError: string | null
  workdir: string | null
  runCount: number
  runs: ExternalAutomationRun[]
}

export type ExternalAutomationRun = {
  id: string
  managerId: string
  provider: ExternalAutomationProvider
  jobId: string
  runAt: string | null
  status: ExternalAutomationRunStatus
  outputPreview: string | null
  outputContent: string | null
  error: string | null
  outputPath: string | null
}

export type ExternalAutomationRunsPage = {
  managerId: string
  provider: ExternalAutomationProvider
  target: ExternalAutomationTarget
  jobId: string
  page: number
  pageSize: number
  total: number
  runs: ExternalAutomationRun[]
}

export type ExternalAutomationRunsInput = {
  managerId: string
  provider: ExternalAutomationProvider
  target: ExternalAutomationTarget
  jobId: string
  page: number
  pageSize: number
}

export type ExternalAutomationCreateInput = {
  managerId: string
  provider: ExternalAutomationProvider
  target: ExternalAutomationTarget
  name: string
  prompt: string
  schedule: string
  workdir: string | null
}

export type ExternalAutomationUpdateInput = ExternalAutomationCreateInput & {
  jobId: string
}

export type ExternalAutomationManager = {
  id: string
  provider: ExternalAutomationProvider
  label: string
  targetLabel: string
  target: ExternalAutomationTarget
  status: ExternalAutomationManagerStatus
  error: string | null
  canManage: boolean
  jobs: ExternalAutomationJob[]
}

export type ExternalAutomationActionInput = {
  managerId: string
  provider: ExternalAutomationProvider
  target: ExternalAutomationTarget
  jobId: string
  action: ExternalAutomationAction
}
