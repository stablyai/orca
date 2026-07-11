import { z } from 'zod'
import { isValidAutomationSchedule } from '../../../../shared/automation-schedules'
import {
  MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS,
  normalizeAutomationPrecheckTimeoutSeconds
} from '../../../../shared/automation-precheck'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import type { TaskProviderIdentity as SharedTaskProviderIdentity } from '../../../../shared/task-source-context'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { defineMethod, type RpcMethod } from '../core'
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

const AutomationId = z.object({
  id: requiredString('Missing automation id')
})

const AutomationRuns = z.object({
  automationId: OptionalString
})

const ExternalAutomationProvider = z.enum(['hermes', 'openclaw'])
const ExternalAutomationIdentity = z.object({
  managerId: requiredString('Missing external automation manager id'),
  provider: ExternalAutomationProvider,
  jobId: requiredString('Missing external automation job id')
})
const ExternalAutomationRuns = ExternalAutomationIdentity.extend({
  page: OptionalPositiveInt,
  pageSize: OptionalPositiveInt
})
const ExternalAutomationMutation = z.object({
  managerId: requiredString('Missing external automation manager id'),
  provider: ExternalAutomationProvider,
  name: requiredString('Missing external automation name'),
  prompt: requiredString('Missing external automation prompt'),
  schedule: requiredString('Missing external automation schedule'),
  workdir: OptionalNullablePlainString
})
const ExternalAutomationUpdate = ExternalAutomationMutation.extend({
  jobId: requiredString('Missing external automation job id')
})
const ExternalAutomationAction = ExternalAutomationIdentity.extend({
  action: z.enum(['pause', 'resume', 'run', 'delete'])
})

const AutomationCreate = z.object({
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
  missedRunGraceMinutes: OptionalPositiveInt
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

const AutomationUpdate = z.object({
  id: requiredString('Missing automation id'),
  updates: AutomationUpdateFields
})

export const AUTOMATION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'automation.externalManagers',
    params: null,
    handler: async (_params, { runtime }) => ({
      managers: await runtime.listExternalAutomationManagers()
    })
  }),
  defineMethod({
    name: 'automation.externalRuns',
    params: ExternalAutomationRuns,
    handler: async (params, { runtime }) => ({
      page: await runtime.listExternalAutomationRuns({
        ...params,
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 25
      })
    })
  }),
  defineMethod({
    name: 'automation.externalCreate',
    params: ExternalAutomationMutation,
    handler: async (params, { runtime }) => {
      await runtime.createExternalAutomation({ ...params, workdir: params.workdir ?? null })
      return { created: true }
    }
  }),
  defineMethod({
    name: 'automation.externalUpdate',
    params: ExternalAutomationUpdate,
    handler: async (params, { runtime }) => {
      await runtime.updateExternalAutomation({ ...params, workdir: params.workdir ?? null })
      return { updated: true }
    }
  }),
  defineMethod({
    name: 'automation.externalAction',
    params: ExternalAutomationAction,
    handler: async (params, { runtime }) => {
      await runtime.runExternalAutomationAction(params)
      return { acted: true }
    }
  }),
  defineMethod({
    name: 'automation.list',
    params: null,
    handler: (_params, { runtime }) => ({ automations: runtime.listAutomations() })
  }),
  defineMethod({
    name: 'automation.show',
    params: AutomationId,
    handler: (params, { runtime }) => ({ automation: runtime.showAutomation(params.id) })
  }),
  defineMethod({
    name: 'automation.create',
    params: AutomationCreate,
    handler: async (params, { runtime }) => ({
      automation: await runtime.createAutomation(params)
    })
  }),
  defineMethod({
    name: 'automation.update',
    params: AutomationUpdate,
    handler: async (params, { runtime }) => ({
      automation: await runtime.updateAutomation(params.id, params.updates)
    })
  }),
  defineMethod({
    name: 'automation.delete',
    params: AutomationId,
    handler: (params, { runtime }) => runtime.deleteAutomation(params.id)
  }),
  defineMethod({
    name: 'automation.runNow',
    params: AutomationId,
    handler: async (params, { runtime }) => ({ run: await runtime.runAutomationNow(params.id) })
  }),
  defineMethod({
    name: 'automation.runs',
    params: AutomationRuns,
    handler: (params, { runtime }) => ({
      runs: runtime.listAutomationRuns(params.automationId)
    })
  })
]
