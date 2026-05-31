import { z } from 'zod'
import { isValidAutomationSchedule } from '../../../../shared/automation-schedules'
import {
  MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS,
  normalizeAutomationPrecheckTimeoutSeconds
} from '../../../../shared/automation-precheck'
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

const AutomationId = z.object({
  id: requiredString('Missing automation id')
})

const AutomationRuns = z.object({
  automationId: OptionalString
})

const AutomationCreate = z.object({
  name: requiredString('Missing automation name'),
  prompt: requiredString('Missing automation prompt'),
  precheck: AutomationPrecheck,
  agentId: TuiAgent,
  repo: OptionalString,
  workspace: OptionalString,
  workspaceMode: AutomationWorkspaceMode,
  baseBranch: OptionalPlainString,
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
  repo: OptionalString,
  workspace: OptionalString,
  workspaceMode: AutomationWorkspaceMode,
  // Why: update patches distinguish omitted from null so callers can clear a saved base branch.
  baseBranch: OptionalNullablePlainString,
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
