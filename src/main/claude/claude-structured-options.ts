import { ClaudeControlRequestError } from './claude-stream-json-connection'
import {
  AgentSessionOptionRejectedError,
  ClaudeEffortValidationError
} from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import {
  observeClaudeSettingsApplied,
  readClaudeSettingsEffort,
  readClaudeSettingsFastMode
} from './claude-structured-session-options'
import type { ClaudeSession } from './structured/claude-structured-session-state'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'

import { beginClaudeOptionMutation } from './claude-structured-execution-observations'
import {
  CLAUDE_APPLY_FLAG_SETTINGS_CONTROL,
  CLAUDE_CACHED_FLAG_CHECK_BUDGET_MS
} from './claude-cli-flag-support'

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const OPTION_ORDER = ['model', 'effort', 'fastMode'] as const

/** Approval mode is fixed at startup: a fallback mode is dropped only by reopening for a newly picked model.
 *  Compares with what Orca itself launched, so the reopened child never matches again. */
export function claudeModelTransitionRestart(
  sessions: ReadonlyMap<string, ClaudeSession>
): NonNullable<StructuredAgentSessionAdapter['requiresModelTransitionRestart']> {
  return (input) => {
    const session = sessions.get(input.sessionId)
    const model = input.executionOptions?.model
    const opened = session?.firstRootInit?.permissionMode
    const requested = session?.launchIntent?.permissionMode
    return Boolean(
      session?.fence === input.fence &&
      model !== undefined &&
      model !== session.launchIntent?.model &&
      requested !== undefined &&
      opened !== undefined &&
      opened !== null &&
      opened !== requested
    )
  }
}

export function restoredClaudeStructuredSessionOptions(
  options: Readonly<Record<string, string>> | undefined
): Map<string, string> {
  return new Map(
    OPTION_ORDER.flatMap((key) => {
      const value = options?.[key]
      return value ? [[key, value] as const] : []
    })
  )
}

const CLAUDE_STRUCTURED_OPTION_KEYS = new Set(['model', 'effort', 'fastMode'])

export function isClaudeStructuredOptionKey(key: string): boolean {
  return CLAUDE_STRUCTURED_OPTION_KEYS.has(key)
}

/** Native writers can replace more than their named input; uncertain writes retire that proof. */
export function beginClaudeInputWrite(session: ClaudeSession, key: string, value?: string): number {
  const affected =
    key === 'model'
      ? ['model', 'effort', 'fastMode']
      : key === 'fastMode' && value === 'true'
        ? ['model', 'effort', 'fastMode']
        : [key]
  for (const input of affected) {
    session.appliedInputOptions.delete(input)
    session.confirmedOptions.delete(input)
  }
  const sequence = beginClaudeOptionMutation(session, key)
  session.settingsObservation = { pending: true }
  return sequence
}

export function finishClaudeInputWrite(session: ClaudeSession, sequence: number): void {
  if (sequence === session.optionMutationSequence) {
    delete session.settingsObservation
  }
}

/** False only once the CLI's version proves it never answers the control; unknown CLIs are tried. */
export async function claudeTakesFlagSettings(
  session: Pick<ClaudeSession, 'cliFlag' | 'flagSettingsControl'>
): Promise<boolean> {
  if (session.cliFlag && (session.flagSettingsControl ?? 'unknown') === 'unknown') {
    session.flagSettingsControl = await session.cliFlag(
      CLAUDE_APPLY_FLAG_SETTINGS_CONTROL,
      CLAUDE_CACHED_FLAG_CHECK_BUDGET_MS,
      false
    )
  }
  return session.flagSettingsControl !== 'unsupported'
}

/** A client's write to a live session. */
export function setClaudeStructuredSessionOption(
  session: ClaudeSession,
  input: { key: string; value: string },
  timeoutMs: number | undefined
): Promise<Readonly<Record<string, string>>> {
  return setClaudeStructuredOption(session, input, timeoutMs)
}

export async function setClaudeStructuredOption(
  session: ClaudeSession,
  input: { key: string; value: string },
  timeoutMs: number | undefined
): Promise<Readonly<Record<string, string>>> {
  const fastMode =
    input.key === 'fastMode'
      ? decodeStructuredAgentSessionOptionValue('fastMode', input.value)
      : null
  const effort = EFFORT_LEVELS.find((value) => value === input.value)
  if (input.key === 'effort' && effort === undefined) {
    throw new ClaudeEffortValidationError()
  }
  if (
    (input.key === 'effort' || input.key === 'fastMode') &&
    !(await claudeTakesFlagSettings(session))
  ) {
    throw new AgentSessionOptionRejectedError(
      'this Claude Code version cannot change effort or Fast mode in a running chat; update Claude Code'
    )
  }
  const apply =
    input.key === 'model'
      ? () => session.connection.setModel(input.value, { timeoutMs })
      : input.key === 'effort' && effort !== undefined
        ? () => session.connection.applyFlagSettings({ effortLevel: effort }, { timeoutMs })
        : input.key === 'fastMode' && typeof fastMode === 'boolean'
          ? () => session.connection.applyFlagSettings({ fastMode }, { timeoutMs })
          : null
  if (!apply) {
    throw new AgentSessionOptionRejectedError(
      `claude stream-json has no session option named ${input.key}`
    )
  }
  if (input.key === 'fastMode') {
    if (typeof fastMode !== 'boolean') {
      throw new AgentSessionOptionRejectedError('claude fast mode must be encoded as true or false')
    }
    if (
      fastMode &&
      session.fastModeDisabledReason &&
      !['preference', 'sdk_opt_in_required'].includes(session.fastModeDisabledReason)
    ) {
      throw new AgentSessionOptionRejectedError(
        `claude Fast mode is unavailable (${session.fastModeDisabledReason})`
      )
    }
  }
  const mutationSequence = beginClaudeInputWrite(session, input.key, input.value)
  // Read with the fence bump, so a write that lands after an earlier one's bookkeeping compares against it.
  const held = session.options.get(input.key)
  try {
    await apply()
    if (mutationSequence === session.optionMutationSequence) {
      session.appliedInputOptions.set(input.key, input.value)
      if (input.key === 'model' && session.fastModeDisabledMutation !== mutationSequence) {
        delete session.fastModeDisabledReason
        delete session.fastModeDisabledMutation
      }
    }
    // Notify the translator even if a newer write superseded this applied control.
    if (input.key === 'model' && input.value !== held) {
      session.translator?.modelMayHaveChanged()
    }
    if (input.key === 'model') {
      session.translator?.modelWritten(input.value)
    }
  } catch (error) {
    if (error instanceof ClaudeControlRequestError) {
      throw new AgentSessionOptionRejectedError(error)
    }
    throw error
  } finally {
    finishClaudeInputWrite(session, mutationSequence)
  }
  if (mutationSequence === session.optionMutationSequence) {
    session.options.set(input.key, input.value)
    session.confirmedOptions.delete(input.key)
    if (input.key === 'model') {
      session.confirmedOptions.delete('effort')
      session.confirmedOptions.delete('fastMode')
    }
    void confirmClaudeOption(session, input, mutationSequence, timeoutMs).catch(() => {})
  }
  return Object.fromEntries(session.options)
}

async function confirmClaudeOption(
  session: ClaudeSession,
  input: { key: string; value: string },
  mutationSequence: number,
  timeoutMs: number | undefined
): Promise<void> {
  const token = { pending: false }
  session.settingsObservation = token
  const settings =
    (input.key === 'effort' && input.value !== 'max') || input.key === 'fastMode'
      ? await session.connection.getSettings({ timeoutMs }).catch(() => null)
      : null
  if (
    session.connection.closed ||
    session.settingsObservation !== token ||
    mutationSequence !== session.optionMutationSequence ||
    settings === null
  ) {
    return
  }
  observeClaudeSettingsApplied(session, settings)
  const adopted =
    input.key === 'fastMode'
      ? readClaudeSettingsFastMode(settings)
      : readClaudeSettingsEffort(settings)
  const decoded =
    input.key === 'fastMode'
      ? decodeStructuredAgentSessionOptionValue('fastMode', input.value)
      : input.value
  if (input.key === 'fastMode' && typeof adopted === 'boolean') {
    session.reportedOptions.fastMode = adopted
    if (!adopted) {
      delete session.fastModeReportedMutation
    }
  } else if (typeof adopted === 'string' && adopted !== decoded) {
    session.reportedOptions.effort = adopted
  }
  if (adopted !== null && adopted === decoded) {
    session.confirmedOptions.add(input.key)
  }
}
