// How the chat-status corpus writes each chat, through a real journal store.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from './journal-store'

/** The fence every case writes its content under; an `unverifiable` turn's writer. */
export const CORPUS_FENCE = 3

const THREAD = 'thread-corpus'

export function codexItem(turnId: string, ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: THREAD, turnId, ordinal }
}

export async function item(
  journal: AgentSessionJournal,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): Promise<void> {
  await journal.appendItem(identity, body, {
    fence: CORPUS_FENCE,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
}

export async function send(
  journal: AgentSessionJournal,
  clientMessageId: string,
  text: string,
  handoverRecorded?: true
): Promise<void> {
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: `fp-${clientMessageId}`,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    fence: CORPUS_FENCE,
    ...(handoverRecorded ? { handoverRecorded } : {})
  })
}

export async function settledTurn(journal: AgentSessionJournal, turnId: string): Promise<void> {
  await send(journal, `send-${turnId}`, `asked ${turnId}`)
  await journal.resolveDispatch({
    clientMessageId: `send-${turnId}`,
    state: 'accepted',
    providerIdentity: codexItem(turnId, 1),
    fence: CORPUS_FENCE
  })
  await item(journal, codexItem(turnId, 0), {
    kind: 'turn',
    turnId,
    state: 'completed',
    outcome: 'success',
    startedAt: 10,
    completedAt: 20
  })
  await item(journal, codexItem(turnId, 2), {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: `answered ${turnId}` }]
  })
}

export function userMessage(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

export function assistantMessage(text: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

export const runningTool: Extract<AgentJournalItemBody, { kind: 'tool-call' }> = {
  kind: 'tool-call',
  name: 'shell',
  input: { command: 'ls' },
  state: 'running'
}

export function roster(state: 'working' | 'completed'): AgentJournalItemBody {
  return {
    kind: 'message',
    role: 'system',
    blocks: [
      {
        type: 'subagent-group',
        groupId: 'group-1',
        agents: [{ id: 'child-1', label: 'reads', state, startedAt: 10 }]
      }
    ]
  }
}
