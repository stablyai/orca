// Matching a provider's echo of the user's own message onto the submission that
// produced it.
//
// The two halves are one rule, not two: the first finds the submission slot a
// provider item must upsert into, the second settles that submission as accepted
// once the echo lands. Splitting them apart is how a user ends up looking at two
// copies of the message they sent once.

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { dispatchMayMatchProviderEcho } from './journal-dispatch-doubt-reasons'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

export function resolveJournalItemId(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body']
): string {
  const aliased = state.aliases.get(itemId)
  if (aliased) {
    return aliased
  }
  const identity = parseAgentJournalItemKey(itemId)
  if (
    !body ||
    body.kind !== 'message' ||
    body.role !== 'user' ||
    !identity ||
    identity.provider === 'orca'
  ) {
    return itemId
  }
  const fingerprint = structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: state.sessionId,
    fields: { body }
  })
  // Exact payload plus queue order preserves repeated identical sends one-for-one.
  // A held send is excluded outright: nothing the provider echoes can be a message
  // this host has not dispatched yet, so adopting one would show the user a reply
  // to something they have not sent.
  const submission = [...state.submissions.values()]
    .sort((left, right) => left.submittedAt - right.submittedAt)
    .find(
      (candidate) =>
        candidate.queued !== true &&
        dispatchMayMatchProviderEcho(candidate.dispatchState, candidate.reason) &&
        candidate.payloadFingerprint === fingerprint &&
        state.items.get(agentJournalSubmissionKey(candidate.clientMessageId))?.revision === 0
    )
  if (!submission) {
    return itemId
  }
  const submissionId = agentJournalSubmissionKey(submission.clientMessageId)
  state.aliases.set(itemId, submissionId)
  return submissionId
}

export function acceptSubmissionFromProviderItem(
  state: JournalReducerState,
  providerItemId: string,
  resolvedItemId: string,
  row: Pick<JournalRow, 'epoch' | 'seq' | 'fence' | 'ts'>
): void {
  if (providerItemId === resolvedItemId) {
    return
  }
  const submission = [...state.submissions.values()].find(
    (candidate) => agentJournalSubmissionKey(candidate.clientMessageId) === resolvedItemId
  )
  if (
    !submission ||
    submission.dispatchState === 'accepted' ||
    submission.dispatchState === 'rejected'
  ) {
    return
  }
  submission.fence = row.fence
  submission.dispatchState = 'accepted'
  submission.providerItemId = providerItemId
  submission.reason = null
  submission.resolvedAt = row.ts
  delete submission.recovered
  delete submission.queued
  state.receipts.set(submission.clientMessageId, {
    clientMessageId: submission.clientMessageId,
    providerItemId,
    cursor: { epoch: row.epoch, sequence: row.seq },
    acceptedAt: row.ts
  })
}
