// Chats in every state a settlement plan can find, written through a real journal store, for the
// tests of the stored status and the plan that must agree about them.

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { AgentSessionJournal } from './journal-store'
import {
  assistantMessage,
  codexItem,
  CORPUS_FENCE,
  item,
  roster,
  runningTool,
  send,
  settledTurn,
  userMessage
} from './journal-session-state-test-writes'

export { CORPUS_FENCE } from './journal-session-state-test-writes'

/** Each case, written onto a freshly opened (empty) journal. */
export const JOURNAL_SESSION_STATE_CORPUS = {
  empty: async () => undefined,
  settled: (journal: AgentSessionJournal) => settledTurn(journal, 'turn-1'),
  'older turn running beside a newer one': async (journal: AgentSessionJournal) => {
    await item(journal, codexItem('turn-0', 0), {
      kind: 'turn',
      turnId: 'turn-0',
      state: 'running',
      startedAt: 5
    })
    await settledTurn(journal, 'turn-1')
  },
  'working subagent roster': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await item(journal, { provider: 'orca', clientMessageId: 'roster-1' }, roster('working'))
  },
  'live background task': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await item(
      journal,
      { provider: 'orca', clientMessageId: 'claude-background-task:task-1' },
      {
        kind: 'message',
        role: 'system',
        blocks: [
          {
            type: 'background-task',
            taskId: 'task-1',
            kind: 'command',
            label: 'sleep 20',
            state: 'working',
            startedAt: 10
          }
        ]
      }
    )
  },
  'pending prompt': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await item(journal, codexItem('turn-1', 3), {
      kind: 'approval',
      title: 'Approve?',
      detail: null,
      options: [],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    })
  },
  'running tool': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await item(journal, codexItem('turn-1', 4), {
      kind: 'tool-call',
      name: 'shell',
      input: { command: 'ls' },
      state: 'running'
    })
  },
  'pending send': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await send(journal, 'send-pending', 'never answered')
  },
  'unknown send': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await send(journal, 'send-unknown', 'ambiguous')
    await journal.resolveDispatch({
      clientMessageId: 'send-unknown',
      state: 'unknown',
      reason: 'adapter_timeout',
      fence: CORPUS_FENCE
    })
  },
  'queued leftover': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await send(journal, 'send-queued', 'waiting its turn', true)
  },
  'unverifiable turn': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await item(journal, codexItem('turn-2', 0), {
      kind: 'turn',
      turnId: 'turn-2',
      state: 'unverifiable',
      startedAt: 30
    })
  },
  'settled roster': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await item(journal, { provider: 'orca', clientMessageId: 'roster-1' }, roster('completed'))
  },
  'provider echo claiming a send': async (journal: AgentSessionJournal) => {
    const body = userMessage('hello')
    await journal.appendSubmission({
      clientMessageId: 'send-echo',
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: journal.snapshot().sessionId,
        fields: { body }
      }),
      body,
      fence: CORPUS_FENCE
    })
    await item(journal, codexItem('turn-2', 0), {
      kind: 'turn',
      turnId: 'turn-2',
      state: 'running',
      startedAt: 10
    })
    // The provider's copy of the user's own message, matched to the send by its fingerprint.
    await item(journal, codexItem('turn-2', 1), userMessage('hello'))
    await item(journal, codexItem('turn-2', 2), assistantMessage('working on it'))
  },
  'newest reply tombstoned': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await item(journal, codexItem('turn-1', 3), assistantMessage('a later reply'))
    await journal.appendTombstone(codexItem('turn-1', 3), { fence: CORPUS_FENCE })
  },
  'queued send handed over': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await send(journal, 'send-queued', 'waiting its turn', true)
    await journal.resolveDispatch({
      clientMessageId: 'send-queued',
      state: 'pending',
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      fence: CORPUS_FENCE
    })
  },
  'refused send': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await send(journal, 'send-refused', 'nope')
    await journal.resolveDispatch({
      clientMessageId: 'send-refused',
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
        surface: 'rejection'
      }),
      fence: CORPUS_FENCE
    })
  },
  'running turn on a legacy status row': async (journal: AgentSessionJournal) => {
    await item(journal, codexItem('turn-9', 0), {
      kind: 'status',
      text: 'Codex is working',
      turnLifecycle: { turnId: 'turn-9', state: 'running', startedAt: 10 }
    })
  },
  'running work settled by a batch': async (journal: AgentSessionJournal) => {
    await item(journal, codexItem('turn-1', 0), {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'running',
      startedAt: 10
    })
    await item(journal, codexItem('turn-1', 4), runningTool)
    await journal.appendLifecycleBatch({
      settlementId: 'settle-1',
      fence: CORPUS_FENCE,
      recovered: true,
      mutations: [
        {
          kind: 'item',
          identity: codexItem('turn-1', 4),
          body: { ...runningTool, state: 'failed' },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        },
        {
          kind: 'item',
          identity: codexItem('turn-1', 0),
          body: {
            kind: 'turn',
            turnId: 'turn-1',
            state: 'interrupted',
            startedAt: 10,
            completedAt: 20
          },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
    })
  },
  'unknown send recovered': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await send(journal, 'send-recovered', 'lost in a crash')
    await journal.markPendingSubmissionsUnknown(CORPUS_FENCE)
  },
  // A person's Stop found the turn running, then Orca died before the provider ended it.
  "running turn a person's Stop found": async (journal: AgentSessionJournal) => {
    await item(journal, codexItem('turn-2', 0), {
      kind: 'turn',
      turnId: 'turn-2',
      state: 'running',
      startedAt: 10
    })
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-2' }, CORPUS_FENCE)
  }
} satisfies Record<string, (journal: AgentSessionJournal) => Promise<void>>

export type JournalSessionStateCase = keyof typeof JOURNAL_SESSION_STATE_CORPUS

/** Whether each case's stored status shows work a gone process left: what startup selects. */
export const CORPUS_UNSETTLED: Record<JournalSessionStateCase, boolean> = {
  empty: false,
  settled: false,
  'older turn running beside a newer one': true,
  'working subagent roster': true,
  'live background task': true,
  'pending prompt': true,
  'running tool': true,
  'pending send': true,
  'unknown send': true,
  'queued leftover': true,
  // Its verdict was decided when it settled; startup never revises it.
  'unverifiable turn': false,
  'settled roster': false,
  'provider echo claiming a send': true,
  'newest reply tombstoned': false,
  'queued send handed over': true,
  'refused send': false,
  'running turn on a legacy status row': true,
  'running work settled by a batch': false,
  'unknown send recovered': false,
  "running turn a person's Stop found": true
}

export const JOURNAL_SESSION_STATE_CASES = Object.keys(JOURNAL_SESSION_STATE_CORPUS).filter(
  (name): name is JournalSessionStateCase => name in JOURNAL_SESSION_STATE_CORPUS
)

/** Death evidence as a record can carry it: none, an older build's (no owner), naming the
 *  corpus's writer, and naming another owner. */
export const CORPUS_DEATH_EVIDENCE: Record<string, AgentSessionDeathEvidence | null> = {
  none: null,
  'older build, no owner': { kind: 'exit-observed', detail: 'exit', observedAt: 50 },
  'names the writer': {
    kind: 'pid-absent',
    detail: 'gone',
    observedAt: 60,
    ownerFence: CORPUS_FENCE
  },
  'names another owner': {
    kind: 'exit-observed',
    detail: 'exit',
    observedAt: 70,
    ownerFence: CORPUS_FENCE + 1
  },
  // Observed after every journal clock in the corpus: after a Stop event, too.
  'names the writer, after a Stop': {
    kind: 'pid-absent',
    detail: 'gone',
    observedAt: 10_000_000,
    ownerFence: CORPUS_FENCE
  }
}
