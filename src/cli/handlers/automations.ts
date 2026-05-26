/* eslint-disable max-lines -- Why: automation handlers share schedule parsing, target resolution, and RPC payload shaping for one command family. */
import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationSchedulePreset,
  AutomationUpdateInput
} from '../../shared/automations-types'
import type { TuiAgent } from '../../shared/types'
import { buildAutomationRrule, isValidAutomationSchedule } from '../../shared/automation-schedules'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { CommandHandler } from '../dispatch'
import {
  formatAutomationList,
  formatAutomationRemoved,
  formatAutomationRun,
  formatAutomationRuns,
  formatAutomationShow,
  printResult
} from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalWorktreeSelector, resolveCurrentWorktreeSelector } from '../selectors'

type AutomationCreateParams = Omit<AutomationCreateInput, 'projectId' | 'timezone'> & {
  repo?: string
  timezone?: string
  workspace?: string
}

type AutomationUpdateParams = AutomationUpdateInput & {
  repo?: string
  workspace?: string
}

const PRESET_TRIGGERS = new Set<AutomationSchedulePreset>(['hourly', 'daily', 'weekdays', 'weekly'])
const SCHEDULE_MODIFIER_FLAGS = ['day', 'time'] as const

function getScheduleModifierFlag(flags: Map<string, string | boolean>): string | undefined {
  return SCHEDULE_MODIFIER_FLAGS.find((flag) => flags.has(flag))
}

function validateScheduleModifierApplicability(
  flags: Map<string, string | boolean>,
  raw: string
): void {
  const isPreset = PRESET_TRIGGERS.has(raw as AutomationSchedulePreset)
  if (!isPreset) {
    if (flags.has('time')) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--time can only be used with preset automation triggers'
      )
    }
    if (flags.has('day')) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--day can only be used with the weekly automation preset'
      )
    }
    return
  }
  if (raw === 'hourly' && flags.has('time')) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--time cannot be used with the hourly automation preset; use a cron trigger such as "30 * * * *" to choose the minute'
    )
  }
  if (raw !== 'weekly' && flags.has('day')) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--day can only be used with the weekly automation preset'
    )
  }
}

function getOptionalDayFlag(flags: Map<string, string | boolean>): number | undefined {
  const raw = flags.get('day')
  if (raw === undefined) {
    return undefined
  }
  const day = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    throw new RuntimeClientError('invalid_argument', '--day must be an integer from 0 to 6')
  }
  return day
}

function getProviderFlag(flags: Map<string, string | boolean>): TuiAgent {
  const provider = getRequiredStringFlag(flags, 'provider')
  if (!isTuiAgent(provider)) {
    throw new RuntimeClientError('invalid_argument', `Unknown provider: ${provider}`)
  }
  return provider
}

function getOptionalProviderFlag(flags: Map<string, string | boolean>): TuiAgent | undefined {
  const provider = getOptionalStringFlag(flags, 'provider')
  if (provider === undefined) {
    return undefined
  }
  if (!isTuiAgent(provider)) {
    throw new RuntimeClientError('invalid_argument', `Unknown provider: ${provider}`)
  }
  return provider
}

function getTimeFlag(flags: Map<string, string | boolean>): { hour: number; minute: number } {
  const value = flags.get('time')
  if (value === undefined) {
    return { hour: 9, minute: 0 }
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', '--time must use HH:MM format')
  }
  return parseTimeFlag(value)
}

function parseTimeFlag(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) {
    throw new RuntimeClientError('invalid_argument', '--time must use HH:MM format')
  }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new RuntimeClientError('invalid_argument', '--time must be a valid 24-hour time')
  }
  return { hour, minute }
}

function getScheduleFlag(
  flags: Map<string, string | boolean>,
  required: boolean
): { rrule: string; dtstart: number } | undefined {
  const trigger = getOptionalStringFlag(flags, 'trigger')
  const schedule = getOptionalStringFlag(flags, 'schedule')
  if (trigger && schedule) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --trigger or --schedule, not both.'
    )
  }
  const raw = trigger ?? schedule
  if (!raw) {
    const modifier = getScheduleModifierFlag(flags)
    if (modifier) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--${modifier} requires --trigger or --schedule`
      )
    }
    if (required) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --trigger')
    }
    return undefined
  }
  if (raw === 'manual') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Manual-only automations are not supported yet. Create a scheduled automation with --disabled and run it with `orca automations run <id>` when needed.'
    )
  }
  validateScheduleModifierApplicability(flags, raw)
  const { hour, minute } = raw === 'hourly' ? { hour: 0, minute: 0 } : getTimeFlag(flags)
  const dayOfWeek = raw === 'weekly' ? (getOptionalDayFlag(flags) ?? 1) : 1
  const rrule = PRESET_TRIGGERS.has(raw as AutomationSchedulePreset)
    ? buildAutomationRrule({
        preset: raw as Exclude<AutomationSchedulePreset, 'custom'>,
        hour,
        minute,
        dayOfWeek
      })
    : raw
  if (!isValidAutomationSchedule(rrule)) {
    throw new RuntimeClientError('invalid_argument', `Invalid automation trigger: ${raw}`)
  }
  return { rrule, dtstart: Date.now() }
}

function getEnabledFlag(flags: Map<string, string | boolean>): boolean | undefined {
  const enabledFlag = flags.get('enabled')
  const disabledFlag = flags.get('disabled')
  if (typeof enabledFlag === 'string') {
    throw new RuntimeClientError('invalid_argument', '--enabled does not take a value')
  }
  if (typeof disabledFlag === 'string') {
    throw new RuntimeClientError('invalid_argument', '--disabled does not take a value')
  }
  const enabled = enabledFlag === true
  const disabled = disabledFlag === true
  if (enabled && disabled) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --enabled or --disabled, not both.'
    )
  }
  if (enabled) {
    return true
  }
  if (disabled) {
    return false
  }
  return undefined
}

function getReuseSessionFlag(flags: Map<string, string | boolean>): boolean | undefined {
  const reuseFlag = flags.get('reuse-session')
  const freshFlag = flags.get('fresh-session')
  if (typeof reuseFlag === 'string') {
    throw new RuntimeClientError('invalid_argument', '--reuse-session does not take a value')
  }
  if (typeof freshFlag === 'string') {
    throw new RuntimeClientError('invalid_argument', '--fresh-session does not take a value')
  }
  const reuse = reuseFlag === true
  const fresh = freshFlag === true
  if (reuse && fresh) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --reuse-session or --fresh-session, not both.'
    )
  }
  if (reuse) {
    return true
  }
  if (fresh) {
    return false
  }
  return undefined
}

function getWorkspaceModeFlag(
  flags: Map<string, string | boolean>
): 'existing' | 'new_per_run' | undefined {
  const value = getOptionalStringFlag(flags, 'workspace-mode')
  if (value === undefined) {
    return undefined
  }
  if (value === 'existing') {
    return 'existing'
  }
  if (value === 'new-per-run' || value === 'new_per_run') {
    return 'new_per_run'
  }
  throw new RuntimeClientError(
    'invalid_argument',
    '--workspace-mode must be existing or new-per-run'
  )
}

async function resolveDefaultTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: Parameters<CommandHandler>[0]['client']
): Promise<{ repo?: string; workspace?: string }> {
  const repo = getOptionalStringFlag(flags, 'repo')
  if (repo && getOptionalStringFlag(flags, 'workspace')) {
    throw new RuntimeClientError('invalid_argument', 'Use either --repo or --workspace, not both.')
  }
  const workspace = await getOptionalWorktreeSelector(flags, 'workspace', cwd, client)
  if (repo || workspace) {
    return { repo, workspace }
  }
  if (client.isRemote) {
    return {}
  }
  try {
    return { workspace: await resolveCurrentWorktreeSelector(cwd, client) }
  } catch {
    return {}
  }
}

async function getExplicitTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: Parameters<CommandHandler>[0]['client']
): Promise<{ repo?: string; workspace?: string }> {
  const repo = getOptionalStringFlag(flags, 'repo')
  if (repo && getOptionalStringFlag(flags, 'workspace')) {
    throw new RuntimeClientError('invalid_argument', 'Use either --repo or --workspace, not both.')
  }
  const workspace = await getOptionalWorktreeSelector(flags, 'workspace', cwd, client)
  return { repo, workspace }
}

export const AUTOMATION_HANDLERS: Record<string, CommandHandler> = {
  'automations list': async ({ client, json }) => {
    const result = await client.call<{ automations: Automation[] }>('automation.list')
    printResult(result, json, formatAutomationList)
  },
  'automations show': async ({ flags, client, json }) => {
    const result = await client.call<{ automation: Automation }>('automation.show', {
      id: getRequiredStringFlag(flags, 'id')
    })
    printResult(result, json, formatAutomationShow)
  },
  'automations create': async ({ flags, client, cwd, json }) => {
    const schedule = getScheduleFlag(flags, true)
    if (!schedule) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --trigger')
    }
    const target = await resolveDefaultTarget(flags, cwd, client)
    const workspaceMode =
      getWorkspaceModeFlag(flags) ?? (target.workspace ? 'existing' : 'new_per_run')
    const result = await client.call<{ automation: Automation }>('automation.create', {
      name: getRequiredStringFlag(flags, 'name'),
      prompt: getRequiredStringFlag(flags, 'prompt'),
      agentId: getProviderFlag(flags),
      repo: target.repo,
      workspace: target.workspace,
      workspaceMode,
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      reuseSession: getReuseSessionFlag(flags),
      timezone: getOptionalStringFlag(flags, 'timezone'),
      enabled: getEnabledFlag(flags),
      missedRunGraceMinutes: getOptionalPositiveIntegerFlag(flags, 'missed-run-grace-minutes'),
      ...schedule
    } satisfies AutomationCreateParams)
    printResult(result, json, formatAutomationShow)
  },
  'automations edit': async ({ flags, client, cwd, json }) => {
    const target = await getExplicitTarget(flags, cwd, client)
    const schedule = getScheduleFlag(flags, false)
    const result = await client.call<{ automation: Automation }>('automation.update', {
      id: getRequiredStringFlag(flags, 'id'),
      updates: {
        name: getOptionalStringFlag(flags, 'name'),
        prompt: getOptionalStringFlag(flags, 'prompt'),
        agentId: getOptionalProviderFlag(flags),
        repo: target.repo,
        workspace: target.workspace,
        workspaceMode: getWorkspaceModeFlag(flags),
        baseBranch: getOptionalStringFlag(flags, 'base-branch'),
        reuseSession: getReuseSessionFlag(flags),
        timezone: getOptionalStringFlag(flags, 'timezone'),
        enabled: getEnabledFlag(flags),
        missedRunGraceMinutes: getOptionalPositiveIntegerFlag(flags, 'missed-run-grace-minutes'),
        ...schedule
      } satisfies AutomationUpdateParams
    })
    printResult(result, json, formatAutomationShow)
  },
  'automations remove': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const result = await client.call<{ removed: boolean; id: string }>('automation.delete', { id })
    printResult(result, json, formatAutomationRemoved)
  },
  'automations run': async ({ flags, client, json }) => {
    const result = await client.call<{ run: AutomationRun }>('automation.runNow', {
      id: getRequiredStringFlag(flags, 'id')
    })
    printResult(result, json, formatAutomationRun)
  },
  'automations runs': async ({ flags, client, json }) => {
    const result = await client.call<{ runs: AutomationRun[] }>('automation.runs', {
      automationId: getOptionalStringFlag(flags, 'id')
    })
    printResult(result, json, formatAutomationRuns)
  }
}
