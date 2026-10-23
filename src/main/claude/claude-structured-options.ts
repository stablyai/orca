import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import {
  observeClaudeSettingsApplied,
  readClaudeSettingsEffort,
  readClaudeSettingsFastMode
} from './claude-structured-session-options'
import type { ClaudeSession } from './claude-structured-session-state'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'

import { beginClaudeOptionMutation } from './claude-structured-execution-observations'

const OPTION_ORDER = ['model', 'effort', 'fastMode'] as const

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

/** The keys `setClaudeStructuredOption` writes; a pick made at rest is checked against these. */
const CLAUDE_STRUCTURED_OPTION_KEYS = new Set(['model', 'effort', 'fastMode'])

export function isClaudeStructuredOptionKey(key: string): boolean {
  return CLAUDE_STRUCTURED_OPTION_KEYS.has(key)
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
  const apply =
    input.key === 'model'
      ? () => session.connection.setModel(input.value, { timeoutMs })
      : input.key === 'effort'
        ? () =>
            session.connection.applyFlagSettings(
              { effortLevel: input.value as EffortLevel },
              { timeoutMs }
            )
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
  session.appliedInputOptions.delete(input.key)
  const mutationSequence = beginClaudeOptionMutation(session, input.key)
  // Read with the fence bump, so a write that lands after an earlier one's bookkeeping compares against it.
  const held = session.options.get(input.key)
  try {
    await apply()
    if (mutationSequence === session.optionMutationSequence) {
      session.appliedInputOptions.set(input.key, input.value)
    }
    // Ahead of the fence checks: the child applied this write even if a newer one supersedes its bookkeeping.
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
  }
  // Readback confirms presentation; accepted input remains independent of optional reports.
  // Max is session-only; settings readback reports the underlying level.
  const settings =
    (input.key === 'effort' && input.value !== 'max') || input.key === 'fastMode'
      ? await session.connection.getSettings({ timeoutMs }).catch(() => null)
      : null
  if (mutationSequence !== session.optionMutationSequence) {
    return Object.fromEntries(session.options)
  }
  if (settings !== null) {
    observeClaudeSettingsApplied(session, settings)
    if (readClaudeSettingsFastMode(settings) === false) {
      delete session.fastModeReportedMutation
    }
  }
  const adopted =
    input.key === 'fastMode'
      ? readClaudeSettingsFastMode(settings)
      : readClaudeSettingsEffort(settings)
  if (input.key === 'fastMode' && typeof adopted === 'boolean') {
    session.reportedOptions.fastMode = adopted
    if (!adopted) {
      delete session.fastModeReportedMutation
    }
  }
  // A disagreement stops main vouching for the value, it does not veto the write:
  // the pre-flight guard already refused levels the model advertises no control for,
  // so what is left is the child reporting a value it chose for itself. Keep the
  // child's own answer so the disagreement survives as the level a later read falls
  // back to.
  const decodedInput = input.key === 'fastMode' ? fastMode : input.value
  if (adopted !== null && adopted !== decodedInput) {
    if (typeof adopted === 'string') {
      session.reportedOptions.effort = adopted
    }
  }
  session.options.set(
    input.key,
    input.key === 'fastMode' && typeof adopted === 'boolean' ? String(adopted) : input.value
  )
  // Only a readback that agreed is adoption evidence; one that disagreed or could
  // not be taken records the value but must not also claim the provider vouched for it.
  if (adopted !== null && adopted === decodedInput) {
    session.confirmedOptions.add(input.key)
  } else {
    session.confirmedOptions.delete(input.key)
  }
  // The effort readback was taken under the old model, so a model switch retires
  // it: the child keeps the value but nothing has reported the new model holding
  // it, and vouching for it would show a confirmed effort no readback covers.
  if (input.key === 'model') {
    session.confirmedOptions.delete('effort')
    session.confirmedOptions.delete('fastMode')
  }
  return Object.fromEntries(session.options)
}
