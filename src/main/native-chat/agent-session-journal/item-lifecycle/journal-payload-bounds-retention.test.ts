import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalToolCallState
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import '../../../codex/structured/items/codex-structured-item-translation'
import '../../agent-session-wire/publication/history/agent-session-item-wire-form'
import { journalPayload } from './journal-payload-bounds'
import { createJournalReducerState } from '../projection/journal-reducer'
import {
  buildJournalItemRow,
  journalLifecycleBatchRowBuilder
} from '../writing/journal-row-builders'

afterEach(() => vi.restoreAllMocks())

describe('journal payload allocation bounds', () => {
  it('journals running tool output as a preview and the closing revision whole', () => {
    const output = journalPayload('x'.repeat(64 * 1024))
    const preview = { ...output, head: 'x'.repeat(16 * 1024), truncated: true }
    const call = (state: AgentJournalToolCallState): AgentJournalItemBody => ({
      kind: 'tool-call',
      name: 'shell',
      callId: 'call',
      input: null,
      state,
      output
    })
    const journal = createJournalReducerState('session-1', 'epoch-1')
    const itemRow = (body: AgentJournalItemBody) =>
      buildJournalItemRow({
        state: journal,
        itemId: 'call',
        body,
        seq: 1,
        fence: 1,
        ts: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }).body
    const batchRow = (body: AgentJournalItemBody) =>
      journalLifecycleBatchRowBuilder(
        () => journal,
        'settle',
        [{ kind: 'item', itemId: 'call', body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }],
        { fence: 1 }
      )(1, 1).mutations[0]

    expect(itemRow(call('running'))).toMatchObject({ output: preview })
    expect(batchRow(call('running'))).toMatchObject({ body: { output: preview } })
    expect(itemRow(call('completed'))).toMatchObject({ output })
    expect(batchRow(call('failed'))).toMatchObject({ body: { output } })
  })
})
