import type { SetupDecision, TuiAgent } from './types'
import type { TaskSourceContext, WorkspaceRunContext } from './task-source-context'

export type AutomationWorkspaceMode = 'existing' | 'new_per_run'
export type AutomationExecutionTargetType = 'local' | 'ssh'
export type AutomationSchedulerOwner = 'local_host_service' | 'ssh_bridge' | 'remote_host_service'
export type AutomationMissedRunPolicy = 'run_once_within_grace'
export type AutomationRunStatus =
  | 'pending'
  | 'dispatching'
  | 'dispatched'
  | 'completed'
  | 'skipped_precheck'
  | 'skipped_missed'
  | 'skipped_unavailable'
  | 'skipped_needs_interactive_auth'
  | 'dispatch_failed'
/** Why: 'external' added by FE-TASK-AUTO-006/CR-AUTO-005 — a run dispatched
 *  via automation-service's HandleExternalTrigger RPC (see
 *  backend-go/proto/orca/automation/v1/automation.proto), as opposed to a
 *  cron-scheduled or manually-clicked ("Run Now") run. No production caller
 *  invokes that RPC yet (still-blocked TASK-BE-AUTO-009) — this value only
 *  needs to render correctly once a run is recorded with it. */
export type AutomationRunTrigger = 'scheduled' | 'manual' | 'external'

/** Statuses a run can never leave; only these are safe to evict from history. */
export function isFinalAutomationRunStatus(status: AutomationRunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'dispatch_failed' ||
    status === 'skipped_precheck' ||
    status === 'skipped_missed' ||
    status === 'skipped_unavailable' ||
    status === 'skipped_needs_interactive_auth'
  )
}

export type AutomationSchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'
export type AutomationRunUsageProvider = 'claude' | 'codex'
export type AutomationRunUsageStatus = 'known' | 'unavailable'
export type AutomationRunUsageAttribution = 'provider_session_time_window'
export type AutomationRunUsageUnavailableReason =
  | 'run_not_finished'
  | 'provider_unsupported'
  | 'remote_usage_unavailable'
  | 'usage_not_enabled'
  | 'scan_failed'
  | 'no_matching_session'
  | 'ambiguous_session'

export type AutomationRunUsage = {
  status: AutomationRunUsageStatus
  provider: AutomationRunUsageProvider | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningOutputTokens: number | null
  totalTokens: number | null
  estimatedCostUsd: number | null
  estimatedCostSource: 'api_equivalent' | null
  providerSessionId: string | null
  attribution: AutomationRunUsageAttribution | null
  collectedAt: number
  unavailableReason: AutomationRunUsageUnavailableReason | null
  unavailableMessage: string | null
}

export type AutomationRunOutputSnapshot = {
  format: 'plain_text'
  content: string
  capturedAt: number
  truncated: boolean
}

export type AutomationPrecheck = {
  command: string
  timeoutSeconds: number
}

export type AutomationPrecheckResult = {
  command: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  error: string | null
  startedAt: number
  completedAt: number
}

/**
 * CR-AUTO-002 (FE-TASK-AUTO-002) — matches backend-go's
 * automation.v1.AutomationAction/AutomationActionType 1:1 (see
 * backend-go/proto/orca/automation/v1/automation.proto). Only meaningful
 * for automations dispatched via a runtime (backend-go) target —
 * `window.api.automations.*`'s Node "server mode" automations have no
 * concept of an action chain and never populate this.
 */
export type AutomationActionType =
  | 'create_worktree'
  | 'run_agent'
  | 'commit_push'
  | 'create_pr'
  | 'send_notification'
  | 'run_script'

export type AutomationAction = {
  id: string
  type: AutomationActionType
  /** Why: opaque here by design — each action type's own config shape is
   *  decoded/validated by its form component (FE-AUTO-SOL-003/004), not by
   *  this shared type. Serialized to a JSON string only at the
   *  automation-host-client.ts wire boundary (backend-go's config_json). */
  config: Record<string, unknown>
  continueOnFailure?: boolean
}

export type AutomationActionResult = {
  actionId: string
  status: string
  outputJson?: string
  error?: string
}

export type Automation = {
  id: string
  /** Why: optional — legacy (pre-CR-AUTO-002) and Node "server mode"
   *  automations never populate this; a populated actions[] from a
   *  runtime target takes precedence over prompt/agentId at dispatch time
   *  (see backend-go's resolveActions). */
  actions?: AutomationAction[]
  name: string
  prompt: string
  precheck: AutomationPrecheck | null
  agentId: TuiAgent
  /** Why: runContext carries the logical project + host setup identity for
   *  multi-host projects; projectId remains only as the legacy repo-id storage
   *  field for pre-host-context automations.
   *  @deprecated Use runContext.projectId/runContext.repoId or
   *  getAutomationRunRepoId(). */
  runContext?: WorkspaceRunContext | null
  /** Why: task/provider data can come from a different host/account than the
   *  workspace run target, so automations persist it separately. */
  sourceContext?: TaskSourceContext | null
  /** @deprecated Legacy repo-id compatibility field. New code should persist
   *  runContext and use getAutomationRunRepoId() for fallback reads. */
  projectId: string
  executionTargetType: AutomationExecutionTargetType
  executionTargetId: string
  schedulerOwner: AutomationSchedulerOwner
  workspaceMode: AutomationWorkspaceMode
  workspaceId: string | null
  baseBranch: string | null
  setupDecision?: SetupDecision
  reuseSession: boolean
  timezone: string
  rrule: string
  dtstart: number
  enabled: boolean
  nextRunAt: number
  lastRunAt?: number
  missedRunPolicy: AutomationMissedRunPolicy
  missedRunGraceMinutes: number
  createdAt: number
  updatedAt: number
  /** Why: CR-AUTO-007, runtime (backend-go) targets only — Node "server
   *  mode" automations have no run-history retention/timeout concept. 0 or
   *  undefined = backend-go's own default (100 runs / 7200s). */
  maxRunHistory?: number
  runTimeoutSeconds?: number
}

export type AutomationRun = {
  id: string
  automationId: string
  runContext?: WorkspaceRunContext | null
  sourceContext?: TaskSourceContext | null
  title: string
  scheduledFor: number
  status: AutomationRunStatus
  trigger: AutomationRunTrigger
  workspaceId: string | null
  /** Why: run history must remain understandable after the backing workspace
   *  is deleted and its live metadata is gone. */
  workspaceDisplayName?: string | null
  sessionKind: 'terminal'
  chatSessionId: string | null
  terminalSessionId: string | null
  /** Why: a terminal tab can later point at a different pane/PTY. Automation
   *  run reopening must target the pane that actually executed the run. */
  terminalPaneKey: string | null
  terminalPtyId: string | null
  outputSnapshot: AutomationRunOutputSnapshot | null
  precheckResult: AutomationPrecheckResult | null
  usage: AutomationRunUsage | null
  error: string | null
  startedAt: number | null
  dispatchedAt: number | null
  createdAt: number
  /** Why: run titles must stay unique once retention prunes old runs, so the
   *  number can no longer be derived from how many runs are currently kept. */
  runNumber?: number
  /** Why: only populated for runs dispatched via the CR-AUTO-002 action
   *  chain (backend-go runtime targets) — a legacy 1-step run has no
   *  per-action breakdown, only the top-level status/error above. */
  actionResults?: AutomationActionResult[]
}

export type AutomationCreateInput = {
  name: string
  prompt: string
  precheck?: AutomationPrecheck | null
  agentId: TuiAgent
  runContext?: WorkspaceRunContext | null
  sourceContext?: TaskSourceContext | null
  /** @deprecated Legacy repo-id compatibility field required for older stored
   *  automations and clients. Pair it with runContext for new writes. */
  projectId: string
  workspaceMode: AutomationWorkspaceMode
  workspaceId?: string | null
  baseBranch?: string | null
  setupDecision?: SetupDecision
  reuseSession?: boolean
  timezone: string
  rrule: string
  dtstart: number
  enabled?: boolean
  missedRunGraceMinutes?: number
  /** Why: optional, runtime-target-only — see Automation.actions/
   *  maxRunHistory/runTimeoutSeconds. Omitted = automation-host-client.ts
   *  derives a 1-action `run_agent` chain from prompt/agentId instead
   *  (FE-AUTO-SOL-002 §3); set explicitly once multi-action UI
   *  (FE-AUTO-SOL-003/004) exists. */
  actions?: AutomationAction[]
  maxRunHistory?: number
  runTimeoutSeconds?: number
}

export type AutomationUpdateInput = Partial<
  Pick<
    Automation,
    | 'name'
    | 'prompt'
    | 'precheck'
    | 'agentId'
    | 'runContext'
    | 'sourceContext'
    | 'projectId'
    | 'workspaceMode'
    | 'workspaceId'
    | 'baseBranch'
    | 'setupDecision'
    | 'reuseSession'
    | 'timezone'
    | 'rrule'
    | 'dtstart'
    | 'enabled'
    | 'missedRunGraceMinutes'
    | 'actions'
    | 'maxRunHistory'
    | 'runTimeoutSeconds'
  >
>

export type AutomationDispatchRequest = {
  automation: Automation
  run: AutomationRun
  dispatchToken: string
}

export type AutomationDispatchResult = {
  runId: string
  status: AutomationRunStatus
  workspaceId?: string | null
  workspaceDisplayName?: string | null
  terminalSessionId?: string | null
  terminalPaneKey?: string | null
  terminalPtyId?: string | null
  outputSnapshot?: AutomationRunOutputSnapshot | null
  precheckResult?: AutomationPrecheckResult | null
  usage?: AutomationRunUsage | null
  error?: string | null
}

// Why: split into automations-external-types.ts to keep this file under
// AGENTS.md's max-lines limit — Hermes/OpenClaw external-manager types are
// a separate domain from this project's own Automation/AutomationRun model,
// so the split is a natural boundary, not an arbitrary line-count dodge.
export * from './automations-external-types'
