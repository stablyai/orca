// What a send needs from the session before its lease is checked.
//
// A provider child that exits or fails to start hands its lease back. Before this, a send to that
// session was refused `agent_session_ownership_unknown` — which a client reads as "not admitted
// yet" and resends forever — and only a surface hold could ever make a new child. Now the send
// makes sure it has an owner as a step of its own serialized admission: a released lease where
// resume is allowed gets a child first; anything else runs as it is and meets the lease check.
// A restart that fails refuses with a code the client stops auto-retrying on, carrying the
// restart's own cause, and writes that cause into the chat the way a start that failed does, so
// the user sees why. A manual Retry or a new send is a fresh attempt: a refusal before admission
// leaves no ledger row behind.
//
// The ledger's answer comes first, so a send it already holds a row for restarts nothing:
// admission replays or refuses it whoever owns the session now, and a closed session is made
// readable for that, never given a child. Otherwise a child that dies at startup moves the fence,
// the client resends the same message against the new fence, and each replay spawns another
// child that dies the same way.
//
// Running inside the send's serialize is what makes "no child" exact and the fence bookkeeping
// simple: the owner this send (or a hold just ahead of it) replaced is the one the client was
// current as of, so the send is admitted at the fence the restart published.
//
// A child that has not proven its start is still the owner: the send is admitted against it and
// the adapter holds the message until startup lands, or rejects it with the child's own reason
// when the child dies first. The exit settlement writes that reason into the chat.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionWireRefusalCode } from '../../../shared/agent-session-wire-refusals'
import { boundJournalStatusText } from '../agent-session-journal/journal-prompt-body-bounds'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/tui-agent-display-names'
import {
  ownerRestartFailedOutcome,
  providerStartupFailureOutcome
} from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { AgentSessionMutationSessionPreparation } from './structured-agent-session-mutation-admission'
import { isResumableStructuredAgentSessionRecord } from './structured-agent-session-resume-eligibility'
import { rewindRefusal } from './structured-rewind-refusal'

/**
 * What a refused resume means for the send that ran it. `transient`: the resume met a lease
 * someone else is settling, which is not proof it cannot resume — the send runs as the lease
 * stands and admission reports it. `failed`: the restart itself failed; the send answers with the
 * cause and stops the client's retry loop, and the user may clear the cause and retry.
 * `unresumable`: this host has nothing to restart the chat from — no record, or none it can run —
 * so only a new chat continues. A new wire code does not compile until it is classified here.
 */
const RESUME_REFUSAL_OUTCOME: Record<
  AgentSessionWireRefusalCode,
  'transient' | 'failed' | 'unresumable'
> = {
  execution_owner_reconciling: 'transient',
  agent_session_conflict: 'transient',
  agent_session_checkpoint_stale: 'transient',
  agent_session_ownership_unknown: 'transient',
  agent_session_operation_capacity: 'transient',
  structured_agent_session_unsupported: 'unresumable',
  agent_session_operation_conflict: 'failed',
  agent_session_operation_expired: 'failed',
  agent_session_operation_invalid: 'failed',
  agent_session_operation_unknown: 'failed',
  agent_session_item_revision_stale: 'failed',
  agent_session_already_resolved: 'failed',
  agent_session_identity_required: 'unresumable',
  agent_session_journal_unreadable: 'failed',
  agent_session_owner_restart_failed: 'failed'
}

/** Why the record refuses any send right now, whoever owns it; null when a send may run. */
export function structuredAgentSessionSendBlock(
  record: AgentSessionRecord | null
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  const rewind = record?.rewind
  if (rewind?.phase === 'prepared' || rewind?.phase === 'provider-succeeded') {
    return rewindRefusal('outcome-unknown')
  }
  const command = record?.conversationCommand
  if (
    command &&
    ((command.state === 'unknown' && command.phase === 'prepared') ||
      (command.command === 'clear' && command.replacementSessionId))
  ) {
    return {
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        message: command.replacementSessionId
          ? 'This conversation has been cleared. Use the current conversation.'
          : 'The conversation operation is unconfirmed.'
      }
    }
  }
  return null
}

/** Whether this send is the one that must bring the owner back: no child, a lease handed back
 *  cleanly, and nothing on the record that refuses the send anyway. Live, unverifiable, still
 *  reserved, or handed off: that lease is not this send's to replace. */
export function structuredAgentSessionSendNeedsOwner(
  session: StructuredAgentSessionHostSession | undefined,
  record: AgentSessionRecord
): boolean {
  return (
    session?.hasProviderChild !== true &&
    isResumableStructuredAgentSessionRecord(record) &&
    structuredAgentSessionSendBlock(record) === null
  )
}

type SendPreparationContext = Pick<
  StructuredAgentSessionMutationContext,
  'deps' | 'sessions' | 'holds' | 'restoreReadable' | 'publish'
>

export async function prepareStructuredAgentSessionSend(
  context: SendPreparationContext,
  envelope: AgentSessionMutationEnvelope,
  ledger: 'admit' | 'replay',
  record: AgentSessionRecord
): Promise<AgentSessionMutationSessionPreparation> {
  const { sessionId } = record
  if (ledger !== 'admit') {
    if (!context.sessions.has(sessionId)) {
      await context.restoreReadable(sessionId)
    }
    return { ok: true, envelope }
  }
  if (structuredAgentSessionSendNeedsOwner(context.sessions.get(sessionId), record)) {
    const refusal = await restartOwnerForSend(context, envelope, record)
    if (refusal) {
      return { ok: false, refusal }
    }
  }
  return { ok: true, envelope: admitAtResumedFence(context.sessions.get(sessionId), envelope) }
}

/** One restart attempt. Answers with the refusal that ends the send, or null when the send goes
 *  on to admission — after a child, after a transient refusal, or after a fault in the restart's
 *  own bookkeeping, which is reported and never gates the user's action. */
async function restartOwnerForSend(
  context: SendPreparationContext,
  envelope: AgentSessionMutationEnvelope,
  record: AgentSessionRecord
): Promise<AgentSessionWireRefusal | null> {
  const { sessionId } = envelope
  let resumed: Awaited<ReturnType<typeof context.holds.ensureProviderChild>>
  try {
    resumed = await context.holds.ensureProviderChild(sessionId)
  } catch (error) {
    context.deps.onEventSinkError?.({ sessionId, error })
    return null
  }
  const outcome = resumed.ok ? null : RESUME_REFUSAL_OUTCOME[resumed.refusal.code]
  if (resumed.ok || outcome === 'transient') {
    return null
  }
  const refusal = ownerRestartFailedRefusal(record, resumed.refusal, outcome !== 'unresumable')
  context.deps.onEventSinkError?.({
    sessionId,
    error: new Error(`${resumed.refusal.code}: ${resumed.refusal.message}`)
  })
  // A restart whose child died starting leaves the row any start that died leaves, so the chat
  // reads the same whether the send met that death before admission or after it.
  await recordFailedRestart(
    context,
    envelope,
    resumed.refusal.ownerVerdict === 'exited'
      ? providerStartupFailureOutcome(resumed.refusal.message)
      : refusal.message
  )
  return refusal
}

/** The client stops on the code; the message carries the restart's own cause, and the verdict —
 *  when the failed attach proved its child gone — tells a client nothing runs for the session. */
function ownerRestartFailedRefusal(
  record: AgentSessionRecord,
  cause: AgentSessionWireRefusal,
  resumable: boolean
): AgentSessionWireRefusal {
  return {
    code: 'agent_session_owner_restart_failed',
    message: ownerRestartFailedOutcome({
      agentName: TUI_AGENT_DISPLAY_NAMES[record.provider],
      reason: cause.message,
      resumable
    }),
    ...(cause.ownerVerdict ? { ownerVerdict: cause.ownerVerdict } : {})
  }
}

/** The same status row a start that failed leaves in the chat, so the reason outlives the error
 *  strip. The journal is made readable for it when the failed attach left none behind. Keyed by
 *  the send, not the clock: a resend of the same id that fails again adds no second row. */
async function recordFailedRestart(
  context: SendPreparationContext,
  envelope: AgentSessionMutationEnvelope,
  text: string
): Promise<void> {
  const { sessionId } = envelope
  try {
    if (!context.sessions.has(sessionId)) {
      await context.restoreReadable(sessionId)
    }
    const session = context.sessions.get(sessionId)
    if (!session) {
      return
    }
    const settlementId = `failed-restart:${envelope.clientOperationId}`
    await session.journal.appendLifecycleBatch({
      settlementId,
      fence: session.fence,
      recovered: true,
      mutations: [
        {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId: settlementId },
          body: { kind: 'status', text: boundJournalStatusText(text) }
        }
      ]
    })
    context.publish(sessionId, session.journal)
  } catch (error) {
    context.deps.onEventSinkError?.({ sessionId, error })
  }
}

/** A writer current as of the owner this child replaced is current now: the restart was the only
 *  thing that moved the fence, whether this send ran it or one just ahead of it did. */
function admitAtResumedFence(
  session: StructuredAgentSessionHostSession | undefined,
  envelope: AgentSessionMutationEnvelope
): AgentSessionMutationEnvelope {
  return session?.hasProviderChild &&
    session.resumedFromFence !== undefined &&
    envelope.expectedRuntimeFence === session.resumedFromFence
    ? { ...envelope, expectedRuntimeFence: session.fence }
    : envelope
}
