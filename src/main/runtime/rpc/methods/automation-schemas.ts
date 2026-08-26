// Why: the automation method table stays readable only if its field-level validation lives beside it rather than inside it.
import { z } from 'zod'
import { isValidAutomationSchedule } from '../../../../shared/automation-schedules'
import {
  MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS,
  normalizeAutomationPrecheckTimeoutSeconds
} from '../../../../shared/automation-precheck'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import type { TaskProviderIdentity as SharedTaskProviderIdentity } from '../../../../shared/task-source-context'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import {
  OptionalBoolean,
  OptionalPlainString,
  OptionalPositiveInt,
  OptionalString,
  requiredNumber,
  requiredString
} from '../schemas'

const TuiAgent = requiredString('Missing provider').refine(isTuiAgent, {
  message: 'Unknown provider'
})

const AutomationWorkspaceMode = z.enum(['existing', 'new_per_run']).optional()
const SetupDecision = z.enum(['inherit', 'run', 'skip']).optional()
const ExecutionHostId = requiredString('Missing host id').transform((value, ctx) => {
  const hostId = normalizeExecutionHostId(value)
  if (!hostId) {
    ctx.addIssue({ code: 'custom', message: 'Invalid host id' })
    return z.NEVER
  }
  return hostId
})

const AutomationSchedule = requiredString('Missing trigger').refine(isValidAutomationSchedule, {
  message: 'Invalid automation trigger'
})

const AutomationPrecheck = z
  .object({
    command: requiredString('Missing precheck command'),
    timeoutSeconds: OptionalPositiveInt.transform((value) =>
      normalizeAutomationPrecheckTimeoutSeconds(value)
    ).refine((value) => value <= MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS, {
      message: 'Precheck timeout is too large'
    })
  })
  .nullable()
  .optional()

const OptionalNullablePlainString = z
  .unknown()
  .transform((value) => (value === null || typeof value === 'string' ? value : undefined))
  .pipe(z.union([z.string(), z.null(), z.undefined()]))
  .optional()

const TaskProviderIdentity = z
  .custom<SharedTaskProviderIdentity>(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      'provider' in value &&
      ['github', 'gitlab', 'linear', 'jira'].includes(String(value.provider))
  )
  .optional()
  .nullable()

const TaskSourceContext = z
  .object({
    kind: z.literal('task-source'),
    provider: z.enum(['github', 'gitlab', 'linear', 'jira']),
    projectId: requiredString('Missing source project id'),
    hostId: ExecutionHostId,
    projectHostSetupId: OptionalNullablePlainString,
    repoId: OptionalNullablePlainString,
    providerIdentity: TaskProviderIdentity,
    accountLabel: OptionalNullablePlainString
  })
  .optional()
  .nullable()

const WorkspaceRunContext = z
  .object({
    kind: z.literal('workspace-run'),
    projectId: requiredString('Missing run project id'),
    hostId: ExecutionHostId,
    projectHostSetupId: requiredString('Missing project host setup id'),
    repoId: requiredString('Missing repo id'),
    path: requiredString('Missing run path')
  })
  .optional()
  .nullable()

const SshTargetGeneration = requiredNumber('Missing SSH target generation').refine(
  (value) => Number.isSafeInteger(value) && value >= 1,
  { message: 'Invalid SSH target generation' }
)

const OwnedSshSelector = z.object({
  kind: z.literal('ssh'),
  targetId: requiredString('Missing SSH target id'),
  targetGeneration: SshTargetGeneration
})

/** Orphan is accepted here, unlike a destination: a record with no executable host is still deletable. */
const OwnerPreconditionSelector = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  OwnedSshSelector,
  z.object({ kind: z.literal('orphan') })
])

const DestinationSelector = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  OwnedSshSelector
])

export const ExpectedOwner = z.object({ selector: OwnerPreconditionSelector }).optional()
export const Destination = z.object({ selector: DestinationSelector }).optional()

const ListScopeSelector = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  z.object({
    kind: z.literal('ssh'),
    targetId: requiredString('Missing SSH target id'),
    expectedTargetGeneration: SshTargetGeneration
  }),
  z.object({ kind: z.literal('orphan') })
])

/** An omitted selector is the legacy request; old clients keep the authority's complete list. */
export const AutomationList = z.object({ selector: ListScopeSelector.optional() })

export const AutomationId = z.object({
  id: requiredString('Missing automation id'),
  expectedOwner: ExpectedOwner
})

export const AutomationRuns = z.object({
  automationId: OptionalString,
  expectedOwner: ExpectedOwner
})

export const AutomationCreate = z.object({
  name: requiredString('Missing automation name'),
  prompt: requiredString('Missing automation prompt'),
  precheck: AutomationPrecheck,
  agentId: TuiAgent,
  runContext: WorkspaceRunContext,
  sourceContext: TaskSourceContext,
  repo: OptionalString,
  workspace: OptionalString,
  workspaceMode: AutomationWorkspaceMode,
  baseBranch: OptionalPlainString,
  setupDecision: SetupDecision,
  reuseSession: OptionalBoolean,
  timezone: OptionalString,
  rrule: AutomationSchedule,
  dtstart: requiredNumber('Missing trigger start time'),
  enabled: OptionalBoolean,
  missedRunGraceMinutes: OptionalPositiveInt,
  destination: Destination
})

const AutomationUpdateFields = z.object({
  name: OptionalString,
  prompt: OptionalString,
  precheck: AutomationPrecheck,
  agentId: TuiAgent.optional(),
  runContext: WorkspaceRunContext,
  sourceContext: TaskSourceContext,
  repo: OptionalString,
  workspace: OptionalString,
  workspaceMode: AutomationWorkspaceMode,
  // Why: update patches distinguish omitted from null so callers can clear a saved base branch.
  baseBranch: OptionalNullablePlainString,
  setupDecision: SetupDecision,
  reuseSession: OptionalBoolean,
  timezone: OptionalString,
  rrule: AutomationSchedule.optional(),
  dtstart: requiredNumber('Missing trigger start time').optional(),
  enabled: OptionalBoolean,
  missedRunGraceMinutes: OptionalPositiveInt
})

export const AutomationUpdate = z.object({
  id: requiredString('Missing automation id'),
  updates: AutomationUpdateFields,
  expectedOwner: ExpectedOwner,
  destination: Destination
})
