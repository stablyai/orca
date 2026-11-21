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
  it('keeps successful and already reported looks quiet while ordinary chats stay visible', () => {
    const looks = store()
    expect(looks.lookTurnIsQuiet('now', 'success')).toBe(true)
    expect(looks.lookTurnIsQuiet('now', 'failure')).toBe(true)
    expect(looks.lookTurnIsQuiet('told', 'failure')).toBe(false)
    expect(looks.lookTurnIsQuiet('a-chat', 'success')).toBe(false)
    expect(looks.lookTurnIsQuiet('a-chat', 'failure')).toBe(false)
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
