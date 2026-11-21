import { describe, expect, it, vi } from 'vitest'
import { makeTestBotItem } from '../../shared/bots/bot-item.test-fixture'
import { EVAL_BOT, type EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import { serveEvalDecisionItem } from './bot-orchestration-eval-decision-item'

const CHAT = '7d25c94a-f6da-41d3-b075-1823319fbbef'

function seeded(): EvalHostState {
  return {
    bots: [],
    automations: [],
    repos: [],
    timezone: 'UTC',
    decisionItem: {
      item: makeTestBotItem(41, {
        owner: { botId: EVAL_BOT.id, name: EVAL_BOT.name },
        chat: { id: CHAT, title: 'Home Chat', kind: 'home' }
      }),
      comments: []
    }
  }
}

describe('the eval decision item', () => {
  it('applies a status-only set without posting a comment, as the real host does', () => {
    const state = seeded()
    const io = { record: vi.fn(), save: vi.fn() }
    const result = serveEvalDecisionItem(
      state,
      'bots.items.set',
      { callerSessionId: CHAT, item: '41', status: 'done' },
      io
    )
    expect(result.item.status).toBe('done')
    expect(state.decisionItem?.comments).toEqual([])
    expect(io.save).toHaveBeenCalledOnce()
    expect(io.record).toHaveBeenCalledOnce()
  })

  it('needs a reason to cancel, like the host, and writes nothing without one', () => {
    const state = seeded()
    const io = { record: vi.fn(), save: vi.fn() }
    expect(() =>
      serveEvalDecisionItem(
        state,
        'bots.items.set',
        { callerSessionId: CHAT, item: '41', status: 'canceled' },
        io
      )
    ).toThrow('Canceling needs a reason')
    expect(state.decisionItem?.item.status).not.toBe('canceled')
    expect(io.save).not.toHaveBeenCalled()
    expect(
      serveEvalDecisionItem(
        state,
        'bots.items.set',
        { callerSessionId: CHAT, item: '41', status: 'canceled', reason: 'Superseded' },
        io
      ).item.status
    ).toBe('canceled')
  })

  it('settles the open question when the item leaves Needs you', () => {
    const state = seeded()
    const io = { record: vi.fn(), save: vi.fn() }
    serveEvalDecisionItem(
      state,
      'bots.items.set',
      {
        callerSessionId: CHAT,
        item: '41',
        status: 'needs_you',
        comment: 'Ship it now or wait a day?',
        ask: { questions: [{ prompt: 'Ship it now or wait a day?', options: [] }] }
      },
      io
    )
    expect(state.decisionItem?.item.question).not.toBeNull()
    serveEvalDecisionItem(
      state,
      'bots.items.set',
      { callerSessionId: CHAT, item: '41', status: 'done' },
      io
    )
    expect(state.decisionItem?.item.question).toBeNull()
  })

  // The host treats an empty set as no change; the eval refuses it on purpose.
  it('still refuses a set that neither comments nor changes the status', () => {
    const io = { record: vi.fn(), save: vi.fn() }
    expect(() =>
      serveEvalDecisionItem(seeded(), 'bots.items.set', { callerSessionId: CHAT, item: '41' }, io)
    ).toThrow('requires a question or comment')
    expect(io.save).not.toHaveBeenCalled()
  })
})
