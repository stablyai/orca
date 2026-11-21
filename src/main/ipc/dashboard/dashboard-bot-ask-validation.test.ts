import { describe, expect, it } from 'vitest'
import { admitDashboardBotAsks, isDashboardOpenBotItemArgs } from './dashboard-bot-ask-validation'
import { admitDashboardSnapshot } from './dashboard-payload-validation'

const ask = {
  botHostId: 'local',
  botId: 'bot-a',
  botName: 'Reviewer',
  botAvatar: null,
  itemUid: 'uid-7',
  title: 'Pick a release date',
  question: 'Friday or Monday?',
  number: 7,
  activityAt: 1_000
}
const openArgs = { botHostId: 'local', botId: 'bot-a', itemUid: 'uid-7' }

describe('dashboard bot ask validation', () => {
  it('keeps valid asks, drops malformed ones, and leaves older producers alone', () => {
    expect(admitDashboardBotAsks(undefined)).toBeUndefined()
    expect(admitDashboardBotAsks('nope')).toBeNull()
    const malformed = [
      { ...ask, botHostId: 'bogus' },
      { ...ask, number: 1.5 }
    ]
    expect(admitDashboardBotAsks([ask, ...malformed])).toEqual([ask])
  })

  it('carries the asks through snapshot admission', () => {
    const admitted = admitDashboardSnapshot({ generatedAt: 1, cards: [], botAsks: [ask] })
    expect(admitted?.snapshot.botAsks).toEqual([ask])
    expect(admitDashboardSnapshot({ generatedAt: 1, cards: [], botAsks: {} })).toBeNull()
  })

  it('accepts only a bot on a known host and an item uid as open-item args', () => {
    expect(isDashboardOpenBotItemArgs(openArgs)).toBe(true)
    expect(isDashboardOpenBotItemArgs({ ...openArgs, botHostId: 'x' })).toBe(false)
    expect(isDashboardOpenBotItemArgs({ ...openArgs, botId: '' })).toBe(false)
  })
})
