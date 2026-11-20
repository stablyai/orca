import { expect, it, vi } from 'vitest'
import { makeTestBot } from './bot.test-fixture'
import { LOOK_AROUND_DEFAULTS } from '../../shared/bots/bot-look-around'
import { BotLookAroundRunner } from './bot-look-around-runner'
import { BotLookAroundStore } from './bot-look-around-store'
import { beginRun, endRun, EMPTY_BOT_LOOK, type BotLookState } from './bot-look-around-state'
import { lookAroundDecision } from './bot-look-around-schedule'
import { lookAroundNeedsYou, lookAroundScheduleState } from './bot-look-around-status'
import { testRunPower } from './bot-background-run.test-fixture'

it('persists expired hourly misses while later slots succeed and naturally reach Needs you', async () => {
  const setting = {
    ...LOOK_AROUND_DEFAULTS,
    every: 'custom' as const,
    times: ['09:00', '10:00'],
    timezone: 'UTC'
  }
  const bot = makeTestBot({ id: 'b1', lookAround: setting })
  let disk: string | null = null
  const store = new BotLookAroundStore(
    {
      read: () => disk,
      write: async (text) => {
        disk = text
      }
    },
    () => {}
  )
  store.update('b1', (state) => ({
    state: { ...state, armedAt: Date.UTC(2026, 10, 9) },
    result: null
  }))
  let now = Date.UTC(2026, 10, 9, 10, 5)
  const runner = new BotLookAroundRunner({
    bots: () => [bot],
    store,
    now: () => now,
    power: testRunPower(() => now).power,
    hadConversation: async () => true,
    usageLimitOf: async () => null,
    usageLimitContinues: async () => false,
    sessions: {
      startConversation: async (_bot, input) => {
        await input.beforeFirstMessage?.()
        input.beforeDelivery?.()
        return { sessionId: input.sessionId!, clientMessageId: 'm1', fingerprint: 'f' }
      },
      sendToChat: async () => ({
        sessionId: 'unused',
        clientMessageId: 'unused',
        fingerprint: 'unused'
      }),
      release: async () => {}
    },
    watchTurns: async () => ({
      next: async () => ({ outcome: 'success', message: 'NO_REPLY' }),
      dispose: () => {}
    }),
    turnOff: async () => {},
    stopTurn: async () => {},
    turnRunning: () => false
  })
  for (const day of [9, 10, 11]) {
    now = Date.UTC(2026, 10, day, 10, 5)
    await runner.tick()
    await vi.waitFor(() =>
      expect(store.get('b1').runs.at(-1)).toMatchObject({
        scheduledFor: Date.UTC(2026, 10, day, 10),
        endedAt: Date.UTC(2026, 10, day, 10, 5)
      })
    )
    await runner.tick()
  }
  await store.flushed()
  const reopened = new BotLookAroundStore({ read: () => disk, write: async () => {} }, () => {})
  const state = reopened.get('b1')
  expect(state.missedSlots).toEqual([
    Date.UTC(2026, 10, 9, 9),
    Date.UTC(2026, 10, 10, 9),
    Date.UTC(2026, 10, 11, 9)
  ])
  expect(state.runs.map((run) => run.scheduledFor)).toEqual([
    Date.UTC(2026, 10, 9, 10),
    Date.UTC(2026, 10, 10, 10),
    Date.UTC(2026, 10, 11, 10)
  ])
  expect(lookAroundScheduleState(setting, state, now)).toMatchObject({
    repeatTrouble: { scheduledFor: Date.UTC(2026, 10, 11, 9), failed: 0, missed: 3, of: 3 }
  })
  expect(lookAroundNeedsYou(setting, state, now)).toBe(3)
})

it('does not infer a miss for completed slots whose run details were trimmed', () => {
  const setting = {
    ...LOOK_AROUND_DEFAULTS,
    every: 'custom' as const,
    times: [
      '00:00',
      '02:00',
      '04:00',
      '06:00',
      '08:00',
      '10:00',
      '12:00',
      '14:00',
      '16:00',
      '18:00',
      '20:00',
      '22:00'
    ],
    weekdaysOnly: false,
    timezone: 'UTC'
  }
  let state: BotLookState = { ...EMPTY_BOT_LOOK, armedAt: Date.UTC(2026, 9, 30) }
  for (const day of [1, 2, 3, 4, 5, 6]) {
    for (const hour of [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]) {
      const at = Date.UTC(2026, 10, day, hour)
      const sessionId = `${day}-${hour}`
      state = endRun(beginRun(state, sessionId, at, { scheduledFor: at }), sessionId, at + 60_000)
    }
  }
  expect(lookAroundDecision(setting, state, Date.UTC(2026, 10, 6, 23, 30)).missedAt).toBeUndefined()
})
