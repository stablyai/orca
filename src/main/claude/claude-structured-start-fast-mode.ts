// A saved Fast the Claude child was launched without, applied once its start has read the settings
// that decide whether it may run.

import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import { readClaudeModels } from './claude-structured-init-proof'
import { listedModels } from './claude-structured-model-catalog'
import { claudeModelFastModeSupport } from './claude-structured-session-options'
import type { ClaudeStartupFacts, ClaudeStartupReport } from './claude-structured-session-startup'
import type { ClaudeSession } from './claude-structured-session-state'

/** A saved Fast the launch left out (`fastModeAtStart`): on for a new conversation, whose settings
 *  may opt in to it per session, or either value beside the agent Arguments' own `--settings`.
 *  Those settings now read: a new conversation's opt-in drops it, as before, and so do the guards a
 *  live Fast write takes. The value still to be applied, or null. */
export function admitClaudeStartFastMode(
  session: ClaudeSession,
  facts: ClaudeStartupFacts
): string | null {
  const fastMode = session.options.get('fastMode')
  if (!session.fastModeAtStart || fastMode === undefined) {
    return null
  }
  if (fastMode !== 'true') {
    return fastMode
  }
  if (!facts.resumesTranscript && facts.prepared.fastModePerSessionOptIn === true) {
    session.options.delete('fastMode')
    return null
  }
  // Over the listing this start already holds.
  const listed = listedModels({ models: readClaudeModels(facts.initialization) })
  const blocked =
    session.fastModeDisabledReason !== undefined &&
    !['preference', 'sdk_opt_in_required'].includes(session.fastModeDisabledReason)
  if (
    blocked ||
    (listed.length > 0 && claudeModelFastModeSupport(session, listed).supported !== true)
  ) {
    session.options.delete('fastMode')
    session.restoreSkippedOptions.add('fastMode')
    return null
  }
  return fastMode
}

/** Applies a saved Fast the launch left out after `started`, so nothing waits on it. A refusal
 *  drops it as main's refused restore did, from the record too; silence keeps it wanted and
 *  unconfirmed. A write the user made meanwhile owns the option. */
export async function applyClaudeStartFastMode(
  session: ClaudeSession,
  facts: ClaudeStartupFacts,
  fastMode: string,
  report: (event: ClaudeStartupReport) => void
): Promise<void> {
  const sequence = session.optionMutationSequence
  try {
    await session.connection.applyFlagSettings(
      { fastMode: fastMode === 'true' },
      { timeoutMs: facts.requestTimeoutMs }
    )
  } catch (error) {
    if (sequence !== session.optionMutationSequence) {
      return
    }
    session.confirmedOptions.delete('fastMode')
    if (error instanceof ClaudeControlRequestError) {
      session.options.delete('fastMode')
      session.restoreSkippedOptions.add('fastMode')
      report({ type: 'options-skipped', options: { fastMode } })
    }
  }
}
