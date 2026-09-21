import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import {
  AgentSessionOptionRejectedError,
  isAgentSessionOptionRejectedError
} from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import {
  readClaudeCurrentModel,
  readClaudeModelEffortLevels,
  readClaudeSettingsEffort
} from './claude-structured-session-options'
import type { ClaudeSession } from './claude-structured-session-state'

const OPTION_ORDER = ['model', 'effort', 'permissionMode'] as const

/**
 * Efforts the settings readback cannot report. `max` applies for the rest of the
 * session and is excluded from the persisted `effortLevel` by contract, so
 * `get_settings` answers with the level underneath it — an absence of evidence
 * that must not be read as the child refusing a level its own catalog offers.
 */
const UNREPORTED_EFFORTS: ReadonlySet<string> = new Set(['max'])

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

export async function setClaudeStructuredOption(
  session: ClaudeSession,
  input: { key: string; value: string },
  timeoutMs: number | undefined
): Promise<Readonly<Record<string, string>>> {
  const apply =
    input.key === 'model'
      ? () => session.connection.setModel(input.value, { timeoutMs })
      : input.key === 'permissionMode'
        ? () => session.connection.setPermissionMode(input.value as PermissionMode, { timeoutMs })
        : input.key === 'effort'
          ? () =>
              session.connection.applyFlagSettings(
                { effortLevel: input.value as EffortLevel },
                { timeoutMs }
              )
          : null
  if (!apply) {
    throw new AgentSessionOptionRejectedError(
      `claude stream-json has no session option named ${input.key}`
    )
  }
  // The child stores an effort its model has no control for and keeps it across
  // every later model switch and restore, so refuse before the write rather than
  // read the acceptance back as adoption. Refused here, restore drops the stale
  // value instead of replaying it onto a model that cannot use it.
  if (input.key === 'effort') {
    const { modelId, levels } = await readClaudeModelEffortLevels(session, timeoutMs)
    if (levels && !levels.has(input.value)) {
      throw new AgentSessionOptionRejectedError(
        `claude model ${modelId} does not accept effort ${input.value}`
      )
    }
  }
  const modelWasConfirmed = readClaudeCurrentModel(session).confirmed
  const mutationSequence = ++session.optionMutationSequence
  // Only a model write can stale the model report — an effort or permission-mode
  // write does not change what the child is running. Leaving the stamp behind
  // would drop the session back to the written model and refuse, on the next
  // effort write, a level the model actually running advertises.
  if (modelWasConfirmed && input.key !== 'model') {
    session.reportedModelMutation = mutationSequence
  }
  try {
    await apply()
  } catch (error) {
    if (error instanceof ClaudeControlRequestError) {
      throw new AgentSessionOptionRejectedError(error)
    }
    throw error
  }
  // apply_flag_settings answers `success` for an effort it then ignores, so the
  // absence of a throw proves nothing. Ask what the child actually holds.
  const adopted =
    input.key === 'effort' && !UNREPORTED_EFFORTS.has(input.value)
      ? await session.connection
          .getSettings({ timeoutMs })
          .then(readClaudeSettingsEffort)
          .catch(() => null)
      : null
  if (mutationSequence !== session.optionMutationSequence) {
    return Object.fromEntries(session.options)
  }
  // A disagreement stops main vouching for the value, it does not veto the write:
  // the pre-flight guard already refuses levels the model advertises no control
  // for, and no other client refuses on a readback. Keep the child's own answer so
  // the disagreement survives as the level a later read falls back to.
  if (adopted !== null && adopted !== input.value) {
    session.reportedOptions.effort = adopted
  }
  session.options.set(input.key, input.value)
  // Only a readback that agreed is adoption evidence; one that disagreed or could
  // not be taken records the value but must not also claim the provider vouched for it.
  if (adopted !== null && adopted === input.value) {
    session.confirmedOptions.add(input.key)
  } else {
    session.confirmedOptions.delete(input.key)
  }
  // The effort readback was taken under the old model, so a model switch retires
  // it: the child keeps the value but nothing has reported the new model holding
  // it, and vouching for it would show a confirmed effort no readback covers.
  if (input.key === 'model') {
    session.confirmedOptions.delete('effort')
  }
  return Object.fromEntries(session.options)
}

export async function restoreClaudeStructuredSessionOptions(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<void> {
  // Any write that was already in flight belongs to the previous acquisition
  // state and must not repopulate this map after restore starts.
  session.optionMutationSequence += 1
  // The fence bump is not a write, so the report the session already holds is still
  // current as of this instant; leaving the stamp behind would make every restored
  // session read as unconfirmed until its next turn.
  session.reportedModelMutation = session.optionMutationSequence
  const options = [...session.options.entries()]
  session.options.clear()
  for (const [key, value] of options) {
    try {
      await setClaudeStructuredOption(session, { key, value }, timeoutMs)
    } catch (error) {
      if (!isAgentSessionOptionRejectedError(error)) {
        throw error
      }
      // A stale or unavailable preference must not poison every future acquire;
      // the provider's current value remains authoritative and is re-persisted.
      session.restoreSkippedOptions.add(key)
    }
  }
}
