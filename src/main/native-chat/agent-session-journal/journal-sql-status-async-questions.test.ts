import { expect, it } from 'vitest'
import { messageFixture, target } from './journal-sql-message.test-fixture'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { readJournalSqlOpenAsyncQuestion } from './journal-sql-status-async-questions'
import { newestOpenStructuredAgentSessionAsyncQuestion } from '../../../shared/agent-session/view/structured-agent-session-async-questions'
import { scanPendingAsks } from '../../../shared/native-chat/input/native-chat-ask'
import { projectStructuredItemsToNativeChat } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { CODEX_ASYNC_QUESTION_TOOL } from '../../../shared/native-chat/input/questions/codex-async-question-input'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'

function question(callId: string): AgentJournalItemBody {
  return {
    kind: 'message',
    role: 'assistant',
    blocks: [
      {
        type: 'tool-call',
        name: CODEX_ASYNC_QUESTION_TOOL,
        callId,
        input: { questions: [{ title: 'Which report?', options: ['Weekly', 'Monthly'] }] }
      }
    ]
  }
}

function answer(text: string): AgentJournalItemBody {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function journal() {
  const fixture = messageFixture()
  fixture.db.exec(
    `CREATE INDEX journal_items_async_question ON journal_items(session_id,epoch,sequence,sequence_index,ordinal)
     WHERE hidden=0 AND root=1 AND message_role='assistant' AND command_entry=0 AND instr(payload_json,'${CODEX_ASYNC_QUESTION_TOOL}')>0;
     CREATE INDEX journal_items_person_prompt ON journal_items(session_id,epoch,sequence,sequence_index,ordinal)
     WHERE hidden=0 AND prompt=1 AND (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.body.from') END) IS NULL;`
  )
  const items: AgentJournalRenderItem[] = []
  const row = (id: string, sequence: number, body: AgentJournalItemBody) => {
    const item: AgentJournalRenderItem = {
      itemId: id,
      revision: 0,
      sequence,
      observedAt: sequence * 10,
      body,
      turnScope: { kind: 'thread' }
    }
    fixture.seedItem(item)
    items.push(item)
  }
  const codexMessage = (turnId: string, ordinal: number) =>
    agentJournalItemKey({ provider: 'codex', threadId: 'thread', turnId, ordinal })
  const read = () =>
    readJournalSqlOpenAsyncQuestion(
      new JournalSqlStatusContext(new JournalSqlScope(fixture.db, target.sessionId, target.epoch)),
      0
    )
  return { row, codexMessage, items, read }
}

it('a replayed answered call opens no question in the card scan or either host reader', () => {
  const { row, codexMessage, items, read } = journal()
  const original = codexMessage('turn-1', 1)
  const delivered = codexMessage('turn-1', 2)
  const replayed = codexMessage('turn-2', 1)
  row(original, 1, question('call-1'))
  row(delivered, 2, answer('> Which report?\n\nWeekly'))
  row('orca:compaction', 3, {
    kind: 'status',
    text: 'Context compacted',
    presentation: 'compaction'
  })
  row(replayed, 4, question('call-1'))

  expect(scanPendingAsks(projectStructuredItemsToNativeChat(items)).contributors).toEqual([])
  expect(newestOpenStructuredAgentSessionAsyncQuestion(items, [])).toBeUndefined()
  expect(read()).toBeUndefined()

  const fresh = codexMessage('turn-3', 1)
  row(fresh, 5, question('call-2'))
  expect(read()).toEqual({ itemId: fresh, text: 'Which report?' })
})
