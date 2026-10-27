import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import {
  observeClaudeSettingsApplied,
  readClaudeSettingsEffort,
  readClaudeSettingsFastMode
} from './claude-structured-session-options'
import type { ClaudeSession } from './claude-structured-session-state'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'

import { beginClaudeOptionMutation } from './claude-structured-execution-observations'

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
  // Capture the held value before yielding so overlapping writes compare against their own predecessor.
  const held = session.options.get(input.key)
  try {
    await apply()
    if (mutationSequence === session.optionMutationSequence) {
      session.appliedInputOptions.set(input.key, input.value)
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
  }
  // Readback confirms presentation without vetoing an accepted control.
  // Max is session-only; settings report the underlying level.
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
  // Preserve the provider's differing effort for later reads without vetoing the accepted write.
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
  // Only matching readback confirms adoption.
  if (adopted !== null && adopted === decodedInput) {
    session.confirmedOptions.add(input.key)
  } else {
    session.confirmedOptions.delete(input.key)
  }
  // A model switch invalidates effort and Fast confirmations from the old model.
  if (input.key === 'model') {
    session.confirmedOptions.delete('effort')
    session.confirmedOptions.delete('fastMode')
  }
  return Object.fromEntries(session.options)
}
