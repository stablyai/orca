import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { encodeAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import {
  domainLifecycleFixture,
  lifecycleFacts,
  lifecycleTarget,
  lifecycleOptions,
  lifecycleIdentity
} from './journal-domain-lifecycle.test-fixture'
import { prepareJournalAutomaticSubmission } from './journal-domain-automatic-selection'
import { JournalSqlScope } from './journal-sql-scope'
import type {
  JournalAutomaticSelection,
  JournalAutomaticSubmissionFacts
} from './journal-automatic-submission'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import { readJournalDomainSubmissionAttempt } from './journal-domain-submission-records'
import { JournalSqlBatch } from './journal-sql-batch'
import { JournalSqlCommand } from './journal-sql-command'
import type { JournalWriterCommand } from './journal-writer-command'

export const automaticBody = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
export const automaticMail = {
  kind: 'agent' as const,
  senders: [],
  orchestration: {
    message: 'mail-notice' as const,
    mailbox: 'owner',
    dispatchId: null,
    messages: []
  }
}

export function automaticSubmissionFixture(cleanups: (() => void)[]) {
  const f = domainLifecycleFixture(cleanups, 'chat-test')
  const target = { ...lifecycleTarget, sessionId: 'chat-test' }
  const facts = {
    ...lifecycleFacts,
    identity: { ...lifecycleFacts.identity, sessionId: 'chat-test' }
  }
  const record = agentSessionRecordFixture({ sessionId: 'chat-test' })
  f.db
    .prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)')
    .run('chat-test', JSON.stringify(encodeAgentSessionRecord(record)))
  const selection: JournalAutomaticSelection = {
    authority: {
      handle: 'owner',
      record: {
        currentFence: 1,
        ownerObservation: { claimStatus: 'live', unreconciled: false, handoffStage: null }
      },
      child: { fence: 1 },
      handingOver: [],
      continuingUnadmitted: [],
      finalizing: [],
      openedThrough: { epoch: 'epoch', sequence: 0 },
      operationalRevision: 0
    },
    child: {
      fence: 1,
      acquisitionGeneration: 'child',
      ready: true,
      closing: false,
      stopping: false
    },
    steering: {
      kind: 'codex',
      compiler: {
        active: { model: 'active' },
        defaults: { model: 'default' },
        models: [],
        listedServiceTiers: []
      }
    }
  }
  return {
    ...f,
    selection,
    card: (id: string) => journalDomainQueueRow(f.db, target, id)?.card,
    attempt: (id: string) => readJournalDomainSubmissionAttempt(f.db, target, id),
    enqueue: (
      id: string,
      input: Partial<
        Extract<JournalWriterCommand['operation'], { kind: 'queue-insert' }>['input']
      > = {}
    ) =>
      f.run({
        kind: 'queue-insert',
        input: { messageId: id, body: automaticBody(id), deliveryMode: 'steer', ...input }
      }),
    turn: (turnId = 'running') =>
      f.run({
        kind: 'item',
        identity: lifecycleIdentity('turn'),
        body: { kind: 'turn', turnId, state: 'running' },
        options: lifecycleOptions
      }),
    prepare(now = 100): JournalAutomaticSubmissionFacts {
      return {
        selection,
        selectionNow: now,
        owed: 'owed',
        preparation: prepareJournalAutomaticSubmission(
          new JournalSqlScope(f.db, 'chat-test', 'epoch'),
          selection,
          now,
          { reopenFloor: null }
        )
      }
    },
    async claim(
      id: string,
      automatic: JournalAutomaticSubmissionFacts,
      effects?: JournalWriterCommand['effects'],
      savedAt = 100
    ) {
      const command: JournalWriterCommand = {
        target,
        operation: { kind: 'automatic-submission', clientMessageId: id, fence: 1 },
        facts: { ...facts, automatic },
        savedAt,
        effects
      }
      const answer = (
        await new JournalSqlBatch(f.db).run([command], (entry) =>
          new JournalSqlCommand(f.db, f.directory).apply(entry, savedAt)
        )
      ).outcomes[0]!
      if (!answer.committed) {
        throw answer.error
      }
      return answer.value
    }
  }
}
