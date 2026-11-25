import { describe, expect, it, beforeEach } from 'vitest'

import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'

import type { EmptyRetrySend } from './external-conversation-reply-empty-retry'

import { retryAskerOf } from './external-conversation-turn-ends'

import {
  NOW,
  installReplyMatrix,
  admit,
  asked,
  start,
  stampOf
} from './connector-reply-matrix.test-fixture'

// The empty-turn retry over the restart matrix's real journal, fill and recovery.

installReplyMatrix()

describe('an empty turn is asked once more, from its live end only', () => {
  const call = {
    kind: 'tool-call',
    name: 'Read',
    input: { file_path: 'a' },
    state: 'completed'
  } as const
  const tool = (key: string, at: number): AgentJournalRenderItem => ({
    itemId: `tool-${key}`,
    revision: 1,
    sequence: at,
    observedAt: at,
    body: call,
    turnScope: { kind: 'turn', turnItemId: key }
  })
  const asks: AgentJournalMessageItem[] = []
  const send =
    (result: Awaited<ReturnType<EmptyRetrySend>>): EmptyRetrySend =>
    async (_id, body) => {
      asks.push(body)
      return result
    }
  beforeEach(() => asks.splice(0))
  const asking = (result: Awaited<ReturnType<EmptyRetrySend>>) =>
    start({ bot: true, continuationsSettled: Promise.resolve(), retry: { send: send(result) } })
  const stamps = [stampOf('d1')]
  const ended = { sessionId: 'chat-1', stamps, prose: '', bot: true, links: [] }
  const solo = { ...ended, ...retryAskerOf(asked('d1'), stamps) }
  const end = (opener: string, key = 'item:t1', toolsRan = false) => ({
    turnItemId: key,
    openerItemId: agentJournalSubmissionKey(opener),
    outcome: 'success' as const,
    toolsRan,
    turnStartedAt: NOW,
    live: true as const
  })
  const liveEnd = (p: ReturnType<typeof start>, key: string, opener: string, toolsRan: boolean) =>
    p.fillTurn({ ...solo, ...end(opener, key, toolsRan) })

  it('asks once after reads; the retry still empty, its words before a tool included, closes with no answer', async () => {
    const p = asking('accepted')
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), tool('item:t1', 40), ...p.turn('item:t1', 'm1', 'completed')])
    await liveEnd(p, 'item:t1', 'm1', false)
    expect(p.outcomes()).toEqual({ d1: { outcome: null } })
    admit(p.db, 'r1', asks[0]!)
    p.show([...p.items(), p.message('r1'), ...p.turn('item:t2', 'r1', 'completed')])
    await p.fillTurn({ ...solo, earlierProse: 'Let me check.', ...end('r1', 'item:t2') })
    await p.publish()
    expect(asks).toHaveLength(1)
    expect(p.outcomes()).toEqual({ d1: { outcome: 'no_answer', head: 'd1' } })
  })

  it('never holds a row an older build admitted: its own quiet rule fills it live', async () => {
    const p = asking('accepted')
    admit(p.db, 'm1', asked('d1'))
    p.db.prepare('UPDATE journal_connector_replies SET quiet_rule=NULL').run()
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'completed')])
    await liveEnd(p, 'item:t1', 'm1', false)
    expect([asks.length, p.outcomes().d1?.outcome]).toEqual([0, 'no_answer'])
  })

  it('never asks after a tool that may have acted; the thread hears so at once', async () => {
    const p = asking('accepted')
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'completed')])
    await liveEnd(p, 'item:t1', 'm1', true)
    expect(asks).toHaveLength(0)
    expect(p.outcomes()).toEqual({ d1: { outcome: 'no_answer', head: 'd1', toolsRan: true } })
  })

  it('never asks for a turn found at boot; its words before its last tool still answer', async () => {
    const p = asking('accepted')
    admit(p.db, 'm1', asked('d1'))
    const said = p.turn('item:t1', 'm1', 'completed', 'Here it is.')
    p.show([p.message('m1'), ...said.slice(0, 1), tool('item:t1', 60), ...said.slice(1)])
    await p.recovery.boot()
    expect(asks).toHaveLength(0)
    expect(p.outcomes()).toEqual({ d1: { outcome: 'answered', prose: 'Here it is.', head: 'd1' } })
  })

  it('at boot, a chat that posted into its thread keeps its earlier words out of the answer', async () => {
    const p = start({ bot: true, retry: { posted: true, send: send('accepted') } })
    admit(p.db, 'm1', asked('d1'))
    const said = p.turn('item:t1', 'm1', 'completed', 'Here it is.')
    p.show([p.message('m1'), ...said.slice(0, 1), tool('item:t1', 60), ...said.slice(1)])
    await p.recovery.boot()
    expect(asks).toHaveLength(0)
    expect(p.outcomes().d1?.outcome).toBe('no_answer')
  })

  it('never asks when the chat tried a post of its own in the turn', async () => {
    const p = start({ bot: true, retry: { posted: true, send: send('accepted') } })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'completed')])
    await p.fillTurn({ ...solo, earlierProse: 'Posting it.', ...end('m1') })
    expect(asks).toHaveLength(0)
    expect(p.outcomes()).toEqual({ d1: { outcome: 'no_answer', head: 'd1' } })
  })

  it('keeps the root’s answer when a child’s tool call lands after it', async () => {
    const p = start({ bot: true, continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    const said = p.turn('item:t1', 'm1', 'completed', 'Here it is.')
    const child = { ...tool('item:t1', 60), agentId: 'sub-1' }
    p.show([p.message('m1'), ...said.slice(0, 1), child, ...said.slice(1)])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'answered', prose: 'Here it is.', head: 'd1' }
    })
  })

  it('never asks for a turn that answered more than its opener; its earlier words answer', async () => {
    const p = asking('accepted')
    const both = ['d1', 'd2'].map((id, at) => (admit(p.db, `m${at + 1}`, asked(id)), stampOf(id)))
    p.show([p.message('m1'), p.message('m2'), ...p.turn('item:t1', 'm1', 'completed')])
    await p.fillTurn({ ...ended, stamps: both, earlierProse: 'Done.', ...end('m1') })
    expect([asks.length, p.outcomes().d2?.prose]).toEqual([0, 'Done.'])
  })

  it('closes under one answer when the ask is refused, with words from before its tool', async () => {
    const p = asking('refused')
    admit(p.db, 'm1', asked('d1', ['d2']))
    const said = p.turn('item:t1', 'm1', 'completed', 'Here it is.')
    p.show([p.message('m1'), ...said.slice(0, 1), tool('item:t1', 60), ...said.slice(1)])
    await p.fillTurn({ ...solo, stamps: [{ ...stampOf('d1'), carried: ['d2'] }], ...end('m1') })
    await p.publish()
    const closed = { outcome: 'answered', prose: 'Here it is.', head: 'd1' }
    expect([asks.length, p.outcomes()]).toEqual([1, { d1: closed, d2: closed }])
  })

  it('stays quiet when the ask is refused and its words before its tool were the quiet marker', async () => {
    const p = asking('refused')
    admit(p.db, 'm1', asked('d1', ['d2']))
    const said = p.turn('item:t1', 'm1', 'completed', 'NO_REPLY')
    p.show([p.message('m1'), ...said.slice(0, 1), tool('item:t1', 60), ...said.slice(1)])
    await p.fillTurn({ ...solo, stamps: [{ ...stampOf('d1'), carried: ['d2'] }], ...end('m1') })
    await p.publish()
    expect([asks.length, p.outcomes()]).toEqual([
      1,
      { d1: { outcome: 'quiet', head: 'd1' }, d2: { outcome: 'quiet', head: 'd2' } }
    ])
  })
})
