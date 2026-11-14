import type Database from '../../sqlite/sync-database'
import {
  AgentSessionRefusalError,
  refuse
} from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalAppendResult, JournalPromptMutationInput } from './journal-store-contracts'
import { validateJournalPendingPrompt } from './writing/journal-prompt-mutation'
import { applyJournalDomainItem } from './journal-domain-item'
import { journalDomainTimelineReads } from './journal-domain-timeline-reads'
import {
  journalDomainLifecycleCommit,
  type JournalDomainLifecycleCommit
} from './journal-domain-lifecycle'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import { isPlanApprovalSubject } from '../../../shared/agent-session/agent-session-approval-subject'

/** Revision and answer ownership are checked after every preceding writer command. */
export function applyJournalDomainPromptMutation(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  input: JournalPromptMutationInput,
  savedAt: number,
  stopSettle?: JournalStopSettleFact
): JournalDomainLifecycleCommit & { value: JournalAppendResult } {
  const empty = journalDomainLifecycleCommit(db, target)
  const current = journalDomainTimelineReads(db, target).item(input.itemId)
  if (
    input.resolution.state === 'cancelled' &&
    (current?.body.kind === 'approval' || current?.body.kind === 'question') &&
    current.body.resolution.state === 'cancelled'
  ) {
    return {
      ...empty,
      value: { itemId: current.itemId, revision: current.revision, cursor: empty.cursor }
    }
  }
  const pending = validateJournalPendingPrompt(current ?? undefined, target.sessionId, input)
  if (!pending.ok) {
    throw new AgentSessionRefusalError(pending.refusal)
  }
  const identity = parseAgentJournalItemKey(input.itemId)
  if (!identity) {
    throw new AgentSessionRefusalError(
      refuse(
        'agent_session_operation_invalid',
        { reason: 'requestMalformed' },
        `Item id ${input.itemId} is not a well-formed item key.`
      )
    )
  }
  const written = applyJournalDomainItem(
    db,
    target,
    {
      kind: 'item',
      identity,
      body: { ...pending.prompt, resolution: input.resolution },
      options: input.options
    },
    savedAt,
    stopSettle
  )
  const item = written.items.find((item) => item.itemId === current!.itemId)!
  const cursor = { ...empty.cursor, sequence: written.cursor.sequence }
  const choice =
    pending.prompt.kind === 'approval' &&
    isPlanApprovalSubject(pending.prompt.subject) &&
    input.resolution.state === 'resolved'
      ? input.resolution.selectedOptionId
      : undefined
  const planApprovalMode =
    choice === 'allow' || choice === 'allowForSession'
      ? ('default' as const)
      : choice === 'deny'
        ? ('plan' as const)
        : undefined
  return {
    ...written,
    cursor,
    removedItemIds: [],
    coordinates: [
      {
        kind: 'item',
        epoch: target.epoch,
        seq: cursor.sequence,
        promptAnswer: {
          itemId: item.itemId,
          revision: item.revision,
          resolution: input.resolution
        },
        ...(planApprovalMode ? { planApprovalMode } : {})
      }
    ],
    value: { itemId: item.itemId, revision: item.revision, cursor }
  }
}
