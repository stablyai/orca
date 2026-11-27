import { describe, expect, it } from 'vitest'
import { threadLinesOf } from './thread-status-lines'

const conversation = { source: 'slack', externalId: 'T1:C1:1.0:U0BOT' } as const
const OK = { ok: true, value: undefined }
const kinds = (path: string, body: unknown, result: { ok: boolean; value?: unknown } = OK) =>
  threadLinesOf(path, body, result).lines.map((line) => line.kind)
const events = (...list: unknown[]) => ({ v: 1, helloRev: 1, seq: 1, events: list })
const ended = (extra: Record<string, unknown>) => ({
  kind: 'turn-ended',
  conversation,
  paneKey: 'pane',
  turnId: 5,
  at: 9,
  stopReason: null,
  ...extra
})

describe('threadLinesOf', () => {
  it("tells Orca's own status replies from every other reply", () => {
    const reply = (replyId: string) => ({ v: 1, replyId, conversation, turnId: 1, text: 'x' })
    expect(threadLinesOf('/v1/connector/replies', reply('status-abc'), OK).lines).toEqual([
      { conversation, kind: 'host', replyId: 'status-abc' }
    ])
    // An outbox answer, the leave line and the failed-start notice are all the bot's.
    for (const replyId of ['outcome-1', 'leave-1', 'start-failed-1']) {
      expect(kinds('/v1/connector/replies', reply(replyId))).toEqual(['bot'])
    }
    expect(kinds('/v1/connector/replies', reply('status-abc'), { ok: false })).toEqual([])
  })

  it('counts only the events that put words in the thread', () => {
    const counted = [
      { kind: 'reply', conversation, outcome: 'answered' },
      ended({ lastAssistantMessage: 'Done.', origin: 'delivery' }),
      ended({ failure: { code: 'x' }, origin: 'delivery' }),
      ended({ lastAssistantMessage: 'Mine.', origin: 'local', mirror: true }),
      { kind: 'prompt', conversation, prompt: { promptId: 'p1' } }
    ]
    const silent = [
      { kind: 'reply', conversation, outcome: 'quiet' },
      ended({ stateOnly: true, lastAssistantMessage: 'x', origin: 'delivery' }),
      ended({ origin: 'delivery' }),
      ended({ lastAssistantMessage: 'Typed in Orca.', origin: 'local' }),
      { kind: 'prompt', conversation, prompt: { promptId: 'p2', raisedBy: 'orca' } },
      { kind: 'prompt', conversation, prompt: { promptId: 'p3' }, answered: true },
      { kind: 'workers', conversation, paneKey: 'pane', running: true }
    ]
    expect(kinds('/v1/connector/events', events(...counted))).toEqual(counted.map(() => 'bot'))
    expect(kinds('/v1/connector/events', events(...silent))).toEqual([])
    expect(kinds('/v1/connector/events', events(...counted), { ok: false })).toEqual([])
  })

  it('opens shown prompts, closes answered ones, and ends them with any turn end', () => {
    const notes = threadLinesOf(
      '/v1/connector/events',
      events(
        { kind: 'prompt', conversation, prompt: { promptId: 'p1' } },
        { kind: 'prompt', conversation, prompt: { promptId: 'p1' }, answered: true },
        ended({ stateOnly: true })
      ),
      OK
    )
    // The turn end came last in the batch: no prompt it ended is left to open.
    expect(notes.prompts).toEqual([])
    expect(notes.turnEnds).toEqual([conversation])
    const after = threadLinesOf(
      '/v1/connector/events',
      events(ended({ stateOnly: true }), {
        kind: 'prompt',
        conversation,
        prompt: { promptId: 'p2' }
      }),
      OK
    )
    expect(after.prompts).toEqual([{ conversation, promptId: 'p2', open: true }])
  })

  it("counts an action only when it posted into the chat's own thread", () => {
    const act = (verb: string, args: Record<string, unknown>, extra = {}) => ({
      v: 1,
      botId: 'bot-1',
      verb,
      args,
      conversation,
      ...extra
    })
    const posted = { ok: true, value: { ok: true, result: {} } }
    expect(kinds('/v1/connector/actions', act('reply', { text: 'hi' }), posted)).toEqual(['bot'])
    expect(kinds('/v1/connector/actions', act('post', { text: 'hi' }), posted)).toEqual(['bot'])
    for (const body of [
      act('reply', { upload: { name: 'a.png' } }),
      act('reply', { stage: true }),
      act('reply', { text: 'later', postAt: '2026-11-27T00:00:00Z' }),
      act('post', { text: 'elsewhere' }, { ref: 'slack:place:C2' }),
      act('read', {}),
      { ...act('reply', { text: 'hi' }), conversation: undefined }
    ]) {
      expect(kinds('/v1/connector/actions', body, posted)).toEqual([])
    }
    const refused = { ok: true, value: { ok: false, refusal: 'not_allowed', message: 'no' } }
    expect(kinds('/v1/connector/actions', act('reply', { text: 'hi' }), refused)).toEqual([])
  })

  it('ignores every other route', () => {
    expect(kinds('/v1/connector/poll', events({ kind: 'reply', conversation }))).toEqual([])
  })
})
