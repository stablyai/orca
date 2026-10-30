import type { AutomationPrecheck, AutomationSchedulePreset } from '../../shared/automations-types'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../shared/task-source-context'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  DEFAULT_AUTOMATION_PRECHECK_TIMEOUT_SECONDS,
  MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS
} from '../../shared/automation-precheck'
import { buildAutomationRrule } from '../../shared/automation-schedule-occurrences'
import { isValidAutomationSchedule } from '../../shared/automation-schedule-parsing'
import { isTuiAgent } from '../../shared/tui-agent-config'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'

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

export function getProviderFlag(flags: Map<string, string | boolean>): TuiAgent {
  const provider = getRequiredStringFlag(flags, 'provider')
  if (!isTuiAgent(provider)) {
    throw new RuntimeClientError('invalid_argument', `Unknown provider: ${provider}`)
  }
  return provider
}

export function getOptionalProviderFlag(
  flags: Map<string, string | boolean>
): TuiAgent | undefined {
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

export function getScheduleFlag(
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

export function getEnabledFlag(flags: Map<string, string | boolean>): boolean | undefined {
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

export function getReuseSessionFlag(flags: Map<string, string | boolean>): boolean | undefined {
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

export function getPrecheckFlag(
  flags: Map<string, string | boolean>
): AutomationPrecheck | null | undefined {
  const hasPrecheck = flags.has('precheck')
  const timeoutSeconds = getOptionalPositiveIntegerFlag(flags, 'precheck-timeout')
  if (!hasPrecheck) {
    if (timeoutSeconds !== undefined) {
      throw new RuntimeClientError('invalid_argument', '--precheck-timeout requires --precheck')
    }
    return undefined
  }
  const value = flags.get('precheck')
  if (typeof value !== 'string') {
    throw new RuntimeClientError('invalid_argument', '--precheck requires a command')
  }
  const command = value.trim()
  if (!command) {
    return null
  }
  if (timeoutSeconds !== undefined && timeoutSeconds > MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--precheck-timeout must be at most ${MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS} seconds`
    )
  }
  return {
    command,
    timeoutSeconds: timeoutSeconds ?? DEFAULT_AUTOMATION_PRECHECK_TIMEOUT_SECONDS
  }
}

export function getSourceContextFlag(
  flags: Map<string, string | boolean>
): TaskSourceContext | null | undefined {
  if (!flags.has('source-context')) {
    return undefined
  }
  const value = flags.get('source-context')
  if (typeof value !== 'string') {
    throw new RuntimeClientError(
      'invalid_argument',
      '--source-context requires a JSON TaskSourceContext or null'
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new RuntimeClientError('invalid_argument', '--source-context must be valid JSON')
  }
  if (parsed === null) {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new RuntimeClientError(
      'invalid_argument',
      '--source-context must be a JSON TaskSourceContext or null'
    )
  }
  const sourceContext = normalizeTaskSourceContext(
    parsed as Parameters<typeof normalizeTaskSourceContext>[0]
  )
  if (!sourceContext) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--source-context is not a valid TaskSourceContext'
    )
  }
  return sourceContext
}

export function getWorkspaceModeFlag(
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
