import { describe, expect, it } from 'vitest'
import { BotLookAroundStore } from './bot-look-around-store'

function store() {
  const looks = new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {})
  looks.update('b1', (state) => ({
    state: {
      ...state,
      runs: [
        { sessionId: 'told', startedAt: 0, endedAt: 1, error: 'x', alerted: true },
        { sessionId: 'now', startedAt: 2 }
      ]
    },
    result: null
  }))
  return looks
}

describe("a look's turns", () => {
  it('are no news when they succeed, whatever the model ended with', () => {
    expect(store().lookTurnIsQuiet('now', 'success')).toBe(true)
  })

  it('follow the failure rule when they fail', () => {
    // The streak before `now` already notified, so this failure is quiet; the first one was news.
    expect(store().lookTurnIsQuiet('now', 'failure')).toBe(true)
    expect(store().lookTurnIsQuiet('told', 'failure')).toBe(false)
  })

  it('leave every other session alone', () => {
    expect(store().lookTurnIsQuiet('a-chat', 'success')).toBe(false)
    expect(store().lookTurnIsQuiet('a-chat', 'failure')).toBe(false)
  })
})

describe('a deleted bot', () => {
  it('leaves nothing of its looks, Up next or dismissals in the saved file', async () => {
    const writes: string[] = []
    const looks = new BotLookAroundStore(
      { read: () => null, write: async (text) => void writes.push(text) },
      () => {}
    )
    looks.update('b1', (state) => ({
      state: { ...state, runs: [{ sessionId: 's', startedAt: 0 }] },
      result: null
    }))
    looks.update('b2', (state) => ({
      state: { ...state, runs: [{ sessionId: 's2', startedAt: 0 }] },
      result: null
    }))
    looks.forget('b1')
    await looks.flushed()

    expect(Object.keys(JSON.parse(writes.at(-1) ?? '{}').bots)).toEqual(['b2'])
    expect(looks.botOfLook('s')).toBeNull()
  })
})
