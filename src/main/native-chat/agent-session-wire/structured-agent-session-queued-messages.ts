// Mid-turn queueing: the accept decision that turns a send into a host-held
// draft, and the one gate the serialized drain (`structured-agent-session-queued-drain.ts`)
// and the published draft list read.
//
// Drafts are never owed work: they feed no reducer, no working status, no
// teardown and no idle sweep. The drain re-reads every gate inside its own
// serialized step, so there is no loop state to disagree with the journal.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueueWait,
  AgentSessionSendResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { queuedSendAnswer } from './structured-agent-session-queued-send-answer'
import { structuredAgentSessionSendBlock } from './structured-agent-session-send-preparation'
import { queuedMessagesPublishedBytesRefusal } from './structured-agent-session-queued-published-bytes'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import {
  structuredAgentSessionHostInstance,
  structuredQueuePauses
} from './structured-agent-session-queued-pause'
import { nextSendableQueuedCard } from '../agent-session-journal/queued-message-pause'
import { isQueuedClearCard, queuedClearWait } from './structured-conversation-clear'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionBackgroundTaskStops } from '../../../shared/agent-child-work-stop-targets'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { agentSessionAttachmentExpiredRefusal } from './structured-agent-session-turns'
import { isAgentSessionAttachmentExpiredError } from '../agent-session-attachments/agent-session-attachment-claims'

/** Text-only v1: any image block routes to the immediate path. */
export function queuedMessageBodyIsTextOnly(body: AgentJournalMessageItem): boolean {
  return body.blocks.every((block) => block.type === 'text')
}

/** Walks the reduced items in place: the gate runs on every admission and
 *  drain step, so it must not render a snapshot of the whole journal. */
export function pendingPromptExists(journal: Pick<AgentSessionJournal, 'visitItems'>): boolean {
  let pending = false
  journal.visitItems((_itemId, _sequence, body) => {
    if (
      !pending &&
      (body.kind === 'approval' || body.kind === 'question') &&
      body.resolution.state === 'pending'
    ) {
      pending = true
    }
  })
  return pending
}

/** Waiting, not held on its own, and not positioned behind a returned card or a
 *  card the queue's pause holds: the queue never reorders. The admission rule
 *  (§accept) and the drain's selection both read it. */
function oldestActionableQueuedMessage(
  journal: Pick<AgentSessionJournal, 'queuedMessages'>
): QueuedMessageRow | null {
  const rows = journal.queuedMessages.list()
  // Nothing waiting costs no pause derivation: this runs on every journal publish.
  if (!rows.some((row) => row.state === 'waiting')) {
    return null
  }
  return nextSendableQueuedCard(structuredQueuePauses(journal), rows)
}

/**
 * Why the queue is not sending right now — ONE decision for admission, the
 * drain step and Send-now, so the lists cannot drift. Each caller's override
 * policy sits next to its use:
 *
 *   admission: `blocked` refuses (the immediate path's own refusal); any other
 *     hold, or an actionable backlog, queues the send as a draft.
 *   drain step: any hold returns early; whatever clears it publishes or
 *     commits, which re-derives.
 *   Send-now: overrides only `working` (plus FIFO order and the stored hold),
 *     never for a command card; `blocked` and `prompt` refuse readably.
 *
 * `blocked` is whatever refuses any send (an uncertain rewind, a cleared source);
 * the rest are waits. A /compact is a queued message and then a turn,
 * so it holds the queue as `working`; an older build's compaction record belongs
 * to a child this host no longer runs and holds nothing. Host-local vocabulary —
 * never on the wire.
 */
export type StructuredQueueHold = 'blocked' | 'working' | 'prompt'

export function structuredQueueHold(input: {
  journal: AgentSessionJournal
  record: AgentSessionRecord | null
  fence: number
}): StructuredQueueHold | null {
  // Whatever refuses any send refuses the queue too: an uncertain rewind or a source a
  // clear superseded. One rule, the immediate path's own.
  if (structuredAgentSessionSendBlock(input.record)) {
    return 'blocked'
  }
  const { journal } = input
  // `prompt` outranks `working`: it is the one wait Send-now may not override,
  // so a prompt raised mid-turn must not read as merely `working`.
  if (pendingPromptExists(journal)) {
    return 'prompt'
  }
  if (
    isStructuredAgentSessionMainAgentWorking(
      journal.activeTurnId(),
      journal.submissions(),
      input.fence
    )
  ) {
    return 'working'
  }
  return null
}

/** What the gate reads beyond the journal. `childWork`, `backgroundTaskStops` and
 *  `stoppedTaskEndingOwed` are read only when a /clear card is next. */
export type StructuredQueueGateInput = {
  journal: AgentSessionJournal
  record: AgentSessionRecord | null
  fence: number
  childWork: () => readonly AgentChildWorkView[] | undefined
  backgroundTaskStops: () => AgentSessionBackgroundTaskStops | undefined
  stoppedTaskEndingOwed: () => boolean
}

/** The card the queue is on once no hold stops it, and what that card still waits for: a /clear
 *  card runs only once background tasks and a handoff end (`queuedClearWait`). The drain, its
 *  schedule, publication and admission all read this one rule. Live facts only; the backlog is
 *  never a gate, so a lone draft drains. */
export function structuredQueueHead(
  input: StructuredQueueGateInput
): { card: QueuedMessageRow; waitsFor: AgentSessionQueueWait['reason'] | null } | null {
  const next = oldestActionableQueuedMessage(input.journal)
  const { journal, fence } = input
  // The gate's cheap `working` first: publication asks on every streamed frame, and the gate's
  // prompt check walks the whole fold.
  if (
    next === null ||
    isStructuredAgentSessionMainAgentWorking(journal.activeTurnId(), journal.submissions(), fence)
  ) {
    return null
  }
  if (structuredQueueHold(input) !== null) {
    return null
  }
  return { card: next, waitsFor: queuedCardWait(next, input) }
}

function queuedCardWait(
  card: Pick<QueuedMessageRow, 'body'>,
  input: Pick<
    StructuredQueueGateInput,
    'record' | 'childWork' | 'backgroundTaskStops' | 'stoppedTaskEndingOwed'
  >
): AgentSessionQueueWait['reason'] | null {
  return isQueuedClearCard(card)
    ? queuedClearWait(
        input.record,
        input.childWork(),
        input.backgroundTaskStops(),
        input.stoppedTaskEndingOwed()
      )
    : null
}

/** The gate's cheap part, for the drain's schedule: an actionable card, the agent idle, and no wait
 *  on the card. The prompt walk is left to the step, which reads the whole gate. */
export function structuredQueueHeadMayRun(input: StructuredQueueGateInput): boolean {
  const next = oldestActionableQueuedMessage(input.journal)
  return (
    next !== null &&
    !isStructuredAgentSessionMainAgentWorking(
      input.journal.activeTurnId(),
      input.journal.submissions(),
      input.fence
    ) &&
    queuedCardWait(next, input) === null
  )
}

/** The card the drain sends next, or null while anything holds the queue or the card waits: the
 *  drain's own pick, so a client told this reads what the drain acts on. */
export function nextStructuredQueuedMessage(
  input: StructuredQueueGateInput
): QueuedMessageRow | null {
  const head = structuredQueueHead(input)
  return head && head.waitsFor === null ? head.card : null
}

/**
 * Whether a `queue-if-active` send becomes a draft: any queue hold short of
 * `blocked`, or an actionable draft already exists (FIFO backlog — an
 * ADMISSION rule only, never a drain gate). A lone returned card, or a paused
 * queue, does not trap a new send: the user acting now wins, and that send's
 * turn starting is what lifts the pause — Orca's own queue policy, a stated
 * deviation from held-head backlog counting. A /clear that would only wait for
 * a handoff or for background tasks the strip can stop waits as a card too, as one sent mid-turn
 * does.
 */
export function shouldQueueStructuredAgentSessionSend(
  input: StructuredQueueGateInput & { body: AgentJournalMessageItem }
): boolean {
  const hold = structuredQueueHold(input)
  if (hold === 'blocked') {
    // The immediate path's own refusal (`structuredAgentSessionSendBlock`)
    // answers; queueing behind a fence would strand the draft.
    return false
  }
  if (hold !== null || oldestActionableQueuedMessage(input.journal) !== null) {
    return true
  }
  return queuedCardWait(input, input) !== null
}

/**
 * The accept branch: a capable send while the session is working (or behind an
 * actionable backlog) becomes a draft instead of a submission. Returns null for
 * the immediate path — an incapable client, an image body (text-only v1), a
 * replayed id the journal already answers, or an idle session.
 */
export async function maybeQueueStructuredAgentSessionSend(
  context: {
    deps: {
      store: { getRecord: (sessionId: string) => AgentSessionRecord | null }
      adapter: Pick<StructuredAgentSessionAdapter, 'backgroundTaskStops' | 'stoppedTaskEndingOwed'>
    }
    readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  },
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'journal' | 'fence' | 'operationReceipt'>,
  params: {
    envelope: { clientOperationId: string }
    body: AgentJournalMessageItem
    delivery?: 'queue-if-active'
    /** A person's send at a chat surface: every attachment it names must still be stored. */
    userSend?: true
    /** A person's message the host sends for them. */
    personsMessage?: true
  }
): Promise<
  | { ok: true; value: AgentSessionSendResult }
  | { ok: false; refusal: AgentSessionWireRefusal }
  | null
> {
  const clientMessageId = params.envelope.clientOperationId
  if (params.delivery !== 'queue-if-active' || !queuedMessageBodyIsTextOnly(params.body)) {
    return null
  }
  // Asked again with no ledger answer: a send this host queued answers as its replay would —
  // its hand-off goes out under a fresh id, so no submission under this id guards it.
  const queuedBefore = queuedSendAnswer(ctx.journal, clientMessageId)
  if (queuedBefore) {
    return { ok: true, value: queuedBefore }
  }
  // A recorded direct submission under this id replays through today's path.
  if (ctx.journal.submissions().some((entry) => entry.clientMessageId === clientMessageId)) {
    return null
  }
  if (
    !shouldQueueStructuredAgentSessionSend({
      journal: ctx.journal,
      record: context.deps.store.getRecord(ctx.sessionId),
      fence: ctx.fence,
      childWork: () => context.readChildWork(ctx.sessionId),
      backgroundTaskStops: () => context.deps.adapter.backgroundTaskStops?.(ctx.sessionId),
      stoppedTaskEndingOwed: () =>
        context.deps.adapter.stoppedTaskEndingOwed?.(ctx.sessionId) === true,
      body: params.body
    })
  ) {
    return null
  }
  const refusal = queuedMessagesPublishedBytesRefusal(
    ctx.journal,
    params.body,
    params.userSend === true || params.personsMessage === true
  )
  if (refusal) {
    return { ok: false, refusal }
  }
  // The insert notifies through the journal's commit listener: publication and
  // the drain re-derive with no call here to forget.
  let row: QueuedMessageRow
  try {
    row = await ctx.journal.queuedMessages.insert(
      {
        messageId: clientMessageId,
        body: params.body,
        // In the session that will send it: the reducer aliases the provider's echo by exactly this.
        fingerprint: agentSessionSendBodyFingerprint(ctx.sessionId, params.body),
        hostInstance: structuredAgentSessionHostInstance(),
        ...(params.userSend ? { requireAttachments: true } : {})
      },
      ctx.operationReceipt
    )
  } catch (error) {
    if (isAgentSessionAttachmentExpiredError(error)) {
      return agentSessionAttachmentExpiredRefusal()
    }
    throw error
  }
  return {
    ok: true,
    value: {
      clientMessageId,
      queued: { messageId: row.messageId, position: row.position, state: row.state }
    }
  }
}
