import { describe, expect, it } from 'vitest'
import { isBotBackgroundRun } from './bot-background-run-records'
import { beginRun } from './bot-look-around-state'
import { BotLookAroundStore } from './bot-look-around-store'

function looks() {
  return new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {})
}

describe('isBotBackgroundRun', () => {
  it('still knows a look once 50 newer looks have pushed it out of the run history', () => {
    const store = looks()
    const look = (index: number) =>
      store.update('b1', (state) => ({
        state: beginRun(state, `look-${index}`, index),
        result: null
      }))
    for (let index = 0; index < 50; index += 1) {
      look(index)
    }
    expect(isBotBackgroundRun(store, { sessionId: 'look-50' })).toBe(false)
    look(50)
    expect(isBotBackgroundRun(store, { sessionId: 'look-50' })).toBe(true)
    expect(store.get('b1').runs.some((run) => run.sessionId === 'look-0')).toBe(false)
    expect(isBotBackgroundRun(store, { sessionId: 'look-0' })).toBe(true)
    expect(isBotBackgroundRun(store, { sessionId: 'a-chat' })).toBe(false)
  })

  it('knows a look from before every run was kept by its name and prompt, unless the owner renamed it', () => {
    const old = {
      sessionId: 'old-look',
      conversationName: 'Look around',
      lastTurn: { prompt: 'Look around: find what is waiting on your owner and suggest up to 3' }
    }
    expect(isBotBackgroundRun(looks(), old)).toBe(true)
    expect(isBotBackgroundRun(looks(), { ...old, conversationNameSource: 'user' })).toBe(false)
    expect(
      isBotBackgroundRun(looks(), { ...old, lastTurn: { prompt: 'look around the repo for me' } })
    ).toBe(false)
  })
})
