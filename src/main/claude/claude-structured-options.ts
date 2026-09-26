import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { ClaudeControlRequestTimeoutError } from './claude-agent-sdk-control-requests'
import {
  AgentSessionOptionRejectedError,
  isAgentSessionOptionRejectedError
} from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import {
  claudeCatalogAdmitsModel,
  claudeModelEffortLevels,
  claudeModelFastModeSupport,
  readClaudeCurrentModel,
  readClaudeListedModels,
  readClaudeSettingsEffort,
  readClaudeSettingsFastMode
} from './claude-structured-session-options'
import type { ClaudeSession } from './claude-structured-session-state'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'

const OPTION_ORDER = ['model', 'effort', 'fastMode', 'permissionMode'] as const

/**
 * Efforts the settings readback cannot report. `max` applies for the rest of the
 * session and is excluded from the persisted `effortLevel` by contract, so
 * `get_settings` answers with the level underneath it — an absence of evidence
 * that must not be read as the child refusing a level its own catalog offers.
 */
const UNREPORTED_EFFORTS: ReadonlySet<string> = new Set(['max'])

/** Writes that can move the main thread to another model or window: `opusplan` runs plan mode on Opus. */
const CONTEXT_WINDOW_KEYS: ReadonlySet<string> = new Set(['model', 'permissionMode'])

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

/** A client's write; the startup restore writes through `setClaudeStructuredOption` directly. */
export function setClaudeStructuredSessionOption(
  session: ClaudeSession,
  input: { key: string; value: string },
  timeoutMs: number | undefined
): Promise<Readonly<Record<string, string>>> {
  // Each write is a control request the CLI answers only after initialize.
  if (session.startup.state !== 'proven') {
    return Promise.reject(
      new AgentSessionOptionRejectedError(
        'Claude is still starting; options can be changed once it is ready.'
      )
    )
  }
  return setClaudeStructuredOption(session, input, timeoutMs)
}

export async function setClaudeStructuredOption(
  session: ClaudeSession,
  input: { key: string; value: string },
  timeoutMs: number | undefined,
  /** What the key held before a restore cleared the map; a live write reads the map. */
  heldBeforeRestore?: string
): Promise<Readonly<Record<string, string>>> {
  const fastMode =
    input.key === 'fastMode'
      ? decodeStructuredAgentSessionOptionValue('fastMode', input.value)
      : null
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
          : input.key === 'fastMode' && typeof fastMode === 'boolean'
            ? () => session.connection.applyFlagSettings({ fastMode }, { timeoutMs })
            : null
  if (!apply) {
    throw new AgentSessionOptionRejectedError(
      `claude stream-json has no session option named ${input.key}`
    )
  }
  // One read answers every catalog question this write asks, so the guards below
  // cannot each pay a round trip for the same list nor disagree about the model.
  // Two writes ask nothing of it and so read nothing: an effort write with no current
  // model has nothing to look up, and turning Fast off needs no support evidence —
  // which is every restore replaying a stored `false`.
  const needsCatalog =
    input.key === 'model' ||
    (input.key === 'fastMode' && fastMode === true) ||
    (input.key === 'effort' && readClaudeCurrentModel(session).id !== undefined)
  const listed = needsCatalog ? await readClaudeListedModels(session, timeoutMs) : []
  // The child stores an effort its model has no control for and keeps it across
  // every later model switch and restore, so refuse before the write rather than
  // read the acceptance back as adoption. Refused here, restore drops the stale
  // value instead of replaying it onto a model that cannot use it.
  if (input.key === 'effort') {
    const { modelId, levels } = claudeModelEffortLevels(session, listed)
    if (levels && !levels.has(input.value)) {
      throw new AgentSessionOptionRejectedError(
        `claude model ${modelId} does not accept effort ${input.value}`
      )
    }
  }
  if (input.key === 'fastMode') {
    if (typeof fastMode !== 'boolean') {
      throw new AgentSessionOptionRejectedError('claude fast mode must be encoded as true or false')
    }
    const support = claudeModelFastModeSupport(session, listed)
    // A catalog that identified nothing is not evidence against this model, the same
    // rule the admit-check below applies — otherwise a CLI that cannot answer has Fast
    // refused on every model. A catalog that did list the model and stayed silent
    // about Fast is still not positive evidence, so that case keeps refusing.
    if (fastMode && listed.length > 0 && support.supported !== true) {
      throw new AgentSessionOptionRejectedError(
        `claude model ${support.modelId ?? 'current'} does not support Fast mode`
      )
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
  // set_model resolves for a model the provider never lists and the session then
  // fails every turn with zero tokens, so the acceptance proves nothing and only
  // the catalog does. Restore replays a pick the provider may since have retired,
  // which reaches here with no user error at all.
  if (input.key === 'model' && !claudeCatalogAdmitsModel(listed, input.value)) {
    throw new AgentSessionOptionRejectedError(`claude does not list a model named ${input.value}`)
  }
  const modelFastModeSupport =
    input.key === 'model' && session.options.get('fastMode') === 'true'
      ? claudeModelFastModeSupport(session, listed, input.value)
      : null
  const modelWasConfirmed = readClaudeCurrentModel(session).confirmed
  const mutationSequence = ++session.optionMutationSequence
  // Read with the fence bump, so a write that lands after an earlier one's bookkeeping compares against it.
  const held = heldBeforeRestore ?? session.options.get(input.key)
  // Only a model write can stale the model report — an effort or permission-mode
  // write does not change what the child is running. Leaving the stamp behind
  // would drop the session back to the written model and refuse, on the next
  // effort write, a level the model actually running advertises.
  if (modelWasConfirmed && input.key !== 'model') {
    session.reportedModelMutation = mutationSequence
  }
  try {
    await apply()
    // Ahead of the fence checks: the child applied this write even if a newer one supersedes its bookkeeping.
    if (CONTEXT_WINDOW_KEYS.has(input.key) && input.value !== held) {
      session.translator?.modelMayHaveChanged()
    }
    if (input.key === 'model') {
      session.translator?.modelWritten(input.value)
      // It described the model this write replaced; the next readback re-reads it.
      delete session.appliedOptions
    }
    if (
      input.key === 'model' &&
      session.options.get('fastMode') === 'true' &&
      modelFastModeSupport?.supported === false
    ) {
      if (mutationSequence !== session.optionMutationSequence) {
        return Object.fromEntries(session.options)
      }
      session.options.set('model', input.value)
      session.options.set('fastMode', 'false')
      session.confirmedOptions.delete('effort')
      session.confirmedOptions.delete('fastMode')
      // The requested model is already accepted; a cleanup failure cannot reject that write.
      await session.connection.applyFlagSettings({ fastMode: false }, { timeoutMs }).catch(() => {})
      return Object.fromEntries(session.options)
    }
  } catch (error) {
    if (error instanceof ClaudeControlRequestError) {
      throw new AgentSessionOptionRejectedError(error)
    }
    throw error
  }
  // apply_flag_settings answers `success` for an effort it then ignores, so the
  // absence of a throw proves nothing. Ask what the child actually holds.
  const adopted =
    (input.key === 'effort' && !UNREPORTED_EFFORTS.has(input.value)) || input.key === 'fastMode'
      ? await session.connection
          .getSettings({ timeoutMs })
          .then((settings) =>
            input.key === 'fastMode'
              ? readClaudeSettingsFastMode(settings)
              : readClaudeSettingsEffort(settings)
          )
          .catch(() => null)
      : null
  if (mutationSequence !== session.optionMutationSequence) {
    return Object.fromEntries(session.options)
  }
  if (input.key === 'fastMode' && typeof adopted === 'boolean') {
    session.reportedOptions.fastMode = adopted
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
      await setClaudeStructuredOption(session, { key, value }, timeoutMs, value)
    } catch (error) {
      // A write the CLI never answered must not fault a start that is otherwise fine. Silence is
      // not a refusal, so the choice stays wanted, unconfirmed, and the next start retries it.
      if (error instanceof ClaudeControlRequestTimeoutError) {
        console.warn(
          `[claude-structured] restore of ${key} for ${session.providerSessionId} was not answered in time; keeping it unconfirmed`
        )
        session.options.set(key, value)
        session.confirmedOptions.delete(key)
        continue
      }
      if (!isAgentSessionOptionRejectedError(error)) {
        throw error
      }
      // A stale or unavailable preference must not poison every future acquire;
      // the provider's current value remains authoritative and is re-persisted.
      session.restoreSkippedOptions.add(key)
      // The journal's window was measured under the value this child did not take.
      if (CONTEXT_WINDOW_KEYS.has(key)) {
        session.translator?.modelMayHaveChanged()
      }
    }
  }
}
