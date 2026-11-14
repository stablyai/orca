import { expect, it, vi } from 'vitest'
import { runtimeFixture } from './worker-quiet-runtime.test-fixture'
import { createFixture } from '../../../../native-chat/agent-session-journal/store-lifecycle/journal-store-contract-test-fixture'
import { applyJournalRow } from '../../../../native-chat/agent-session-journal/projection/journal-reducer'
import { isolateJournalTransition } from '../../../../native-chat/agent-session-journal/projection/journal-reducer-transition'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalItemRow } from '../../../../native-chat/agent-session-journal/durable-rows/journal-row-schema'
import { createStructuredAgentSessionConversationReads } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-conversation-reads'

const fixture = runtimeFixture()
const { chat } = fixture
const journals = createFixture()

it.each([
  [100, 2],
  [1000, 2],
  [100, 20]
])(
  'keeps minute observations independent of %i historical items for %i chat workers',
  async (history, count) => {
    const journal = await journals.open()
    let state = journal['state']
    const turnId = agentJournalItemKey({ provider: 'orca', clientMessageId: 'turn' })
    const write = (
      itemId: string,
      body: JournalItemRow['body'],
      fence = 2,
      revision = 1,
      target = state
    ) => {
      applyJournalRow(target, {
        v: 1,
        epoch: journal.epoch,
        seq: target.lastSequence + 1,
        ts: 0,
        fence,
        kind: 'item',
        itemId,
        revision,
        body,
        recovered: true,
        turnScope: { kind: 'turn', turnItemId: turnId }
      })
    }
    for (let n = 0; n < history; n++) {
      write(
        agentJournalItemKey(journals.item(n)),
        { kind: 'tool-call', name: 'historical', input: {}, state: 'completed' },
        1
      )
    }
    write(turnId, { kind: 'turn', turnId: 'turn', state: 'running', startedAt: 0 })
    const oldTool = agentJournalItemKey(journals.item(history))
    const tool = agentJournalItemKey(journals.item(history + 1))
    write(oldTool, { kind: 'tool-call', name: 'old generation', input: {}, state: 'running' }, 1)
    write(tool, { kind: 'tool-call', name: 'Bash', input: {}, state: 'running' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this synchronous reader only consumes the live session's journal and child fence.
    const context = {
      sessions: new Map([['session-1', { journal, child: { fence: 2 } }]])
    } as ReturnType<Parameters<typeof createStructuredAgentSessionConversationReads>[0]>
    const reads = createStructuredAgentSessionConversationReads(() => context)
    expect(reads.attentionReads.workerProgress('session-1')?.tool).toEqual({
      name: 'Bash',
      startedAt: 0
    })
    const completion = isolateJournalTransition(state, (draft) => {
      write(tool, { kind: 'tool-call', name: 'Bash', input: {}, state: 'completed' }, 2, 2, draft)
    })
    expect(reads.attentionReads.workerProgress('session-1')?.tool).toEqual({
      name: 'Bash',
      startedAt: 0
    })
    state = journal['state'] = completion.adopt()
    expect(reads.attentionReads.workerProgress('session-1')?.tool).toBeUndefined()
    expect(journal.lastProviderActivityAt(2)).toBeUndefined()
    chat.progress.mockImplementation(() => reads.attentionReads.workerProgress('session-1'))
    const { db } = fixture
    const { run } = fixture.workers(count)
    let visited = 0
    function* countItems<T>(source: Iterable<T>): Generator<T, undefined, unknown> {
      for (const item of source) {
        visited++
        yield item
      }
      return undefined
    }
    const values = state.items.values.bind(state.items)
    const entries = state.items.entries.bind(state.items)
    const iterator = state.items[Symbol.iterator].bind(state.items)
    vi.spyOn(state.items, 'values').mockImplementation(() => countItems(values()))
    vi.spyOn(state.items, 'entries').mockImplementation(() => countItems(entries()))
    vi.spyOn(state.items, Symbol.iterator).mockImplementation(() => countItems(iterator()))
    fixture.start()
    vi.advanceTimersByTime(3_600_000)
    const notices = db.getUnreadRunMailbox(run.id, 100, ['status'])
    // No provider event in this fence still owes a 15-minute notice and one doubled-interval reminder.
    expect(notices).toHaveLength(count * 2)
    expect(notices.map((row) => JSON.parse(row.payload!).quietNotice.observedAt).sort()).toEqual([
      ...Array(count).fill(2_700_000),
      ...Array(count).fill(900_000)
    ])
    expect(visited).toBe(0)
    chat.progress.mockClear()
    vi.advanceTimersByTime(60_000)
    expect(visited).toBe(0)
    expect(chat.progress).toHaveBeenCalledTimes(count)
    chat.status = 'idle'
    chat.progress.mockClear()
    vi.advanceTimersByTime(60_000)
    expect(chat.progress).not.toHaveBeenCalled()
    expect(visited).toBe(0)
    expect(journal.lastProviderActivityAt(2)).toBeUndefined()
  }
)
