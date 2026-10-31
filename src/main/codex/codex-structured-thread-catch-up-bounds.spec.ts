import { expect, it, vi } from 'vitest'
import { codexTurnLifecycleIdentity } from './codex-structured-journal-translation-turns'

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  chat as catchUpChat,
  codexWith as catchUpCodexWith,
  turn as catchUpTurn
} from './codex-structured-thread-catch-up.test'

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'

export function registerCodexHistoryBoundsTests(input: {
  codexWith: typeof catchUpCodexWith
  chat: typeof catchUpChat
  turn: typeof catchUpTurn
  sessionId: string
  threadId: string
}): void {
  const { chat, turn, sessionId: SESSION } = input
  it('checks an unchanged saved turn anchor when its context writer wins before display commit', async () => {
    const c = await chat({ now: 1_000 })
    await c.open([], { returnedTurns: [turn(1), turn(2)], paginate: false })
    const identity = codexTurnLifecycleIdentity(SESSION, 'turn-1')
    const old = c.journal.item(agentJournalItemKey(identity))
    if (old?.body.kind !== 'turn') {
      throw new Error('missing saved lifecycle')
    }
    const savedBody = old.body
    const append = c.deferred.sink.tryAppendTransition?.bind(c.deferred.sink)
    if (!append) {
      throw new Error('missing production transition')
    }
    vi.spyOn(c.deferred.sink, 'tryAppendTransition').mockImplementationOnce((transition) => {
      c.deferred.sink.appendItem(
        identity,
        { ...savedBody, contextUsage: { window: { tokens: 500, capturedAt: 2_000 } } },
        { lifecycle: true, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      return append(transition)
    })
    await c.open([], {
      returnedTurns: [
        {
          ...turn(1),
          items: [
            { type: 'userMessage', id: 'u', text: 'ask 1' },
            { type: 'agentMessage', id: 'a', text: 'answer 1' },
            { type: 'agentMessage', id: 'new', text: 'Must not commit through stale anchor' }
          ]
        }
      ],
      paginate: false
    })
    expect(c.texts()).not.toContain('assistant:Must not commit through stale anchor')
    expect(c.journal.item(old.itemId)?.body).toMatchObject({
      contextUsage: { window: { tokens: 500, capturedAt: 2_000 } }
    })
  })

  it('folds N and 10N source replacements and local omissions with bounded indexed work', async () => {
    const counts: number[] = []
    for (const n of [100, 1_000]) {
      const c = await chat({ now: 1_000 })
      let reads = 0
      const items = (status: string) =>
        Array.from({ length: n }, (_, i) => ({
          type: 'commandExecution',
          id: `cmd-${i}`,
          get command() {
            reads++
            return `echo ${i}`
          },
          status,
          aggregatedOutput: status === 'completed' ? 'result' : ''
        }))
      const initial = {
        ...turn(1),
        status: 'inProgress',
        completedAt: undefined,
        items: items('inProgress')
      }
      await c.open(
        [
          {
            ...turn(1),
            items: [
              ...items('completed'),
              ...Array.from({ length: n }, (_, i) => ({ type: 'unsupported', id: `ignored-${i}` }))
            ]
          }
        ],
        { returnedTurns: [initial] }
      )
      counts.push(reads)
      expect(
        c.journal.snapshot().items.filter(({ body }) => body.kind === 'tool-call')
      ).toHaveLength(n)
      expect(c.publications).toHaveLength(1)
    }
    expect(counts).toEqual([400, 4_000])
    console.info('history source command reads N=100/1000:', counts)
    const c = await chat({ now: 1_000 })
    await c.open([], {
      paginate: false,
      returnedTurns: [
        {
          ...turn(1),
          items: Array.from({ length: 1_024 }, (_, i) => ({
            type: 'agentMessage',
            id: `item-${i}`,
            text: 'overflow'
          }))
        }
      ]
    })
    expect(c.journal.snapshot().items).toEqual([])
  })
}
