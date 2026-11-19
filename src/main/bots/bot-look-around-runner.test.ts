import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { makeTestBot } from './bot.test-fixture'
import { LOOK_AROUND_DEFAULTS } from '../../shared/bots/bot-look-around'
import { BotLookAroundStore } from './bot-look-around-store'
import {
  BotLookAroundRunner,
  LOOK_FAILURES,
  LOOK_RUN_LIMIT_MS,
  LOOK_STOP_GRACE_MS
} from './bot-look-around-runner'
import type { BotTurnEnd } from './bot-run-turn-watch'
import { runtimeBotAutomationSessions } from './bot-automation-sessions'
import * as BotChatSession from './bot-chat-session'
import { botStartOptions } from './bot-start-options'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { testRunPower, WITH_CLOCKS } from './bot-background-run.test-fixture'

const { startBotSession } = BotChatSession
vi.mock('./bot-chat-session', async (original) => ({
  ...(await original<typeof BotChatSession>()),
  startBotSession: vi.fn(async () => 'look-session')
}))

const MONDAY_NOON = new Date(2026, 9, 26, 12, 1).getTime()

function harness(
  options: {
    bot?: Partial<Bot>
    turn?: BotTurnEnd
    hadConversation?: boolean
    /** Stops the host takes before it runs nothing for the look. */
    stopsToIdle?: number
    /** The host never answers the Stop. */
    stopHangs?: boolean
    /** While the session is made, before its opening message is admitted. */
    preparing?: () => void
    /** The start never returns: before its opening message, or after sending it. */
    startHangs?: 'before-send' | 'after-send'
    /** The start returns only once this settles, after sending its prompt. */
    startReturns?: Promise<void>
    /** The opening message's durable append lands only once this settles. */
    appending?: Promise<void>
    /** Between the opening message's admission and its append. */
    beforeAppend?: () => void
    /** The start fails after its message was let through to delivery. */
    failAfterDelivery?: true
    /** The host's turn watch is ready only once this settles. */
    watchReady?: Promise<void>
    /** The usage limit that ended the look's turn. */
    usageLimit?: { resetsAt?: number }
    /** Orca continues a usage-limited look's own chat. */
    continues?: boolean
  } = {}
) {
  let now = MONDAY_NOON
  let bot = makeTestBot({ id: 'b1', agent: 'claude', ...options.bot })
  const store = new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {})
  // A turn end that arrives before the run waits for it is kept for it.
  let endTurn: ((end: BotTurnEnd) => void) | null = null
  let early: BotTurnEnd | null = null
  const openRunsAtStart: number[] = []
  const hooks: (undefined | (() => void | Promise<void>))[] = []
  /** Sessions whose opening message the start recorded, and of those, delivered or withdrew. */
  const sent: string[] = []
  const delivered: string[] = []
  const watches = { disposed: 0 }
  const withdrawn: string[] = []
  const sessions = {
    startConversation: vi.fn(
      async (
        _bot: Bot,
        input: {
          text: string
          title: string
          sessionId?: string
          beforeFirstMessage?: () => void | Promise<void>
          beforeDelivery?: () => boolean
        }
      ) => {
        // The look is recorded before its session starts, so its launch knows it only reads.
        openRunsAtStart.push(store.get('b1').runs.filter((run) => run.endedAt === undefined).length)
        // The session is made, then admitted right before its opening message, as Orca's create does.
        options.preparing?.()
        hooks.push(input.beforeFirstMessage)
        if (options.startHangs === 'before-send') {
          await new Promise(() => {})
        }
        await input.beforeFirstMessage?.()
        // The append is the last await; then the chat is registered and its delivery woken,
        // unless the caller's last word withdraws the message.
        options.beforeAppend?.()
        await options.appending
        sent.push(input.sessionId ?? 'unnamed')
        ;(input.beforeDelivery?.() === false ? withdrawn : delivered).push(
          input.sessionId ?? 'unnamed'
        )
        if (options.failAfterDelivery) {
          throw new Error('tab visibility could not be saved')
        }
        if (options.startHangs === 'after-send') {
          await new Promise(() => {})
        }
        await options.startReturns
        return { sessionId: input.sessionId ?? 'unnamed', clientMessageId: 'm1', fingerprint: 'f' }
      }
    ),
    sendToChat: vi.fn(async () => ({ sessionId: 'chat', clientMessageId: 'm2', fingerprint: 'f' })),
    release: vi.fn(async (_sessionId: string) => undefined)
  }
  const turnOff = vi.fn(async () => {})
  let hostRunning = true
  const stopTurn = vi.fn(async (_sessionId: string) => {
    if (options.stopHangs) {
      await new Promise(() => {})
    }
    hostRunning = stopTurn.mock.calls.length < (options.stopsToIdle ?? 1)
  })
  const host = testRunPower()
  const runner = new BotLookAroundRunner({
    bots: () => [bot],
    store,
    hadConversation: async () => options.hadConversation ?? true,
    sessions,
    turnOff,
    stopTurn,
    turnRunning: () => hostRunning,
    usageLimitOf: async () => options.usageLimit ?? null,
    usageLimitContinues: async () => options.continues ?? false,
    watchTurns: async () => {
      await options.watchReady
      return {
        next: () => {
          const ready = options.turn ?? early
          return ready
            ? Promise.resolve(ready)
            : new Promise<BotTurnEnd>((done) => (endTurn = done))
        },
        dispose: () => void (watches.disposed += 1)
      }
    },
    power: host.power,
    now: () => now
  })
  return {
    runner,
    host,
    hooks,
    sent,
    delivered,
    withdrawn,
    watches,
    store,
    sessions,
    turnOff,
    stopTurn,
    openRunsAtStart,
    endTurn: (end: BotTurnEnd) => (endTurn ? endTurn(end) : (early = end)),
    setHostRunning: (running: boolean) => (hostRunning = running),
    setNow: (time: number) => (now = time),
    setBot: (patch: Partial<Bot>) => (bot = { ...bot, ...patch })
  }
}

const success: BotTurnEnd = { outcome: 'success', message: 'NO_REPLY' }

describe('Look around runner', () => {
  it('arms on the first conversation and looks at the first slot a full interval later', async () => {
    const { runner, store, sessions, setNow } = harness({ turn: success })
    await runner.tick()
    expect(store.get('b1').armedAt).toBe(MONDAY_NOON)
    expect(sessions.startConversation).not.toHaveBeenCalled()

    // 16:00 is under four hours after arming at 12:01, so 20:00 is the first look.
    setNow(new Date(2026, 9, 26, 16, 1).getTime())
    await runner.tick()
    expect(sessions.startConversation).not.toHaveBeenCalled()
    setNow(new Date(2026, 9, 26, 20, 1).getTime())
    await runner.tick()
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(sessions.startConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b1' }),
      expect.objectContaining({ title: 'Look around', text: expect.stringContaining('NO_REPLY') })
    )
    expect(store.get('b1').runs[0]?.error).toBeUndefined()
  })

  it('stays unarmed until the bot has a conversation', async () => {
    const { runner, store } = harness({ hadConversation: false })
    await runner.tick()
    expect(store.get('b1').armedAt).toBeUndefined()
  })

  it('records the look before starting it, and a failed turn as a failed look', async () => {
    const { runner, store, openRunsAtStart } = harness({
      turn: { outcome: 'failure', message: 'usage limit' }
    })
    expect(runner.lookNow('b1')).toEqual({ started: true })
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(openRunsAtStart).toEqual([1])
    expect(store.get('b1').runs[0]?.error).toBe(LOOK_FAILURES.unfinished)
  })

  it('refuses Look now while one runs and for an off or paused bot, but not right after one', async () => {
    const { runner, endTurn, store } = harness()
    expect(runner.lookNow('b1')).toEqual({ started: true })
    expect(runner.lookNow('b1')).toEqual({ refused: 'running' })
    await vi.waitFor(() => expect(store.get('b1').runs).toHaveLength(1))
    endTurn(success)
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(runner.lookNow('b1')).toEqual({ started: true })

    const off = { on: false, every: 'every-4h', weekdaysOnly: true, focus: '' } as const
    expect(harness({ bot: { lookAround: off } }).runner.lookNow('b1')).toEqual({ refused: 'off' })
    expect(harness({ bot: { paused: true } }).runner.lookNow('b1')).toEqual({ refused: 'paused' })
    expect(harness({ bot: { agent: 'opencode' } }).runner.lookNow('b1')).toEqual({
      refused: 'unsupported'
    })
    expect(harness().runner.lookNow('missing')).toEqual({ refused: 'not_found' })
  })

  it('ends a look a restart cut off, on the first tick', async () => {
    const { runner, store } = harness({ hadConversation: false })
    store.update('b1', (state) => ({
      state: { ...state, runs: [{ sessionId: 'old', startedAt: 1 }] },
      result: null
    }))
    await runner.tick()
    expect(store.get('b1').runs[0]).toMatchObject({ error: LOOK_FAILURES.interrupted })
  })

  it('leaves a look this process started running through the first tick', async () => {
    const { runner, store, endTurn } = harness({ hadConversation: false })
    runner.lookNow('b1')
    await vi.waitFor(() => expect(store.get('b1').runs).toHaveLength(1))
    await runner.tick()
    expect(store.get('b1').runs[0]?.endedAt).toBeUndefined()
    endTurn(success)
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(store.get('b1').runs[0]?.error).toBeUndefined()
  })
})

describe('failing looks', () => {
  it('turns Look around off after ten failed looks in a row, counting from the last success', async () => {
    const { runner, store, turnOff } = harness({
      turn: { outcome: 'failure', message: 'usage limit' }
    })
    store.update('b1', (state) => ({
      state: {
        ...state,
        runs: [
          { sessionId: 'ok', startedAt: 0, endedAt: 1 },
          ...Array.from({ length: 8 }, (_, n) => ({
            sessionId: `failed-${n}`,
            startedAt: 2 + n,
            endedAt: 3 + n,
            error: LOOK_FAILURES.unfinished
          }))
        ]
      },
      result: null
    }))
    runner.lookNow('b1')
    await vi.waitFor(() => expect(store.get('b1').runs.at(-1)?.endedAt).toBeDefined())
    expect(turnOff).not.toHaveBeenCalled()
    runner.lookNow('b1')
    await vi.waitFor(() => expect(turnOff).toHaveBeenCalledTimes(1))
  })

  it('never turns Look around off for looks a usage limit ended', async () => {
    const resetsAt = MONDAY_NOON + 60 * 60 * 1000
    const { runner, store, turnOff } = harness({
      turn: { outcome: 'failure', message: 'usage limit' },
      usageLimit: { resetsAt }
    })
    store.update('b1', (state) => ({
      state: {
        ...state,
        runs: Array.from({ length: 9 }, (_, n) => ({
          sessionId: `failed-${n}`,
          startedAt: n,
          endedAt: n + 1,
          error: LOOK_FAILURES.unfinished
        }))
      },
      result: null
    }))
    runner.lookNow('b1')
    await vi.waitFor(() => expect(store.get('b1').runs.at(-1)?.endedAt).toBeDefined())
    expect(store.get('b1').runs.at(-1)?.usageLimited).toEqual({ resetsAt })
    runner.lookNow('b1')
    await vi.waitFor(() => expect(store.get('b1').runs).toHaveLength(11))
    await vi.waitFor(() => expect(store.get('b1').runs.at(-1)?.endedAt).toBeDefined())
    expect(turnOff).not.toHaveBeenCalled()
    // The owner hears of the limit once, not of every look it ends.
    expect(
      store
        .get('b1')
        .runs.slice(-2)
        .map((run) => run.alerted)
    ).toEqual([true, undefined])
    // The host's turn-end notice follows the same rule.
    const [first, second] = store.get('b1').runs.slice(-2)
    expect(store.lookTurnIsQuiet(first!.sessionId, 'failure', true)).toBe(false)
    expect(store.lookTurnIsQuiet(second!.sessionId, 'failure', true)).toBe(true)
  })

  it("starts no look for a usage-limited look's owed slot while Orca continues that look's chat", async () => {
    const limitedLook = (continues: boolean) => {
      const h = harness({ turn: success, continues })
      h.store.update('b1', (state) => ({
        state: {
          ...state,
          armedAt: new Date(2026, 9, 20, 9).getTime(),
          runs: [
            {
              sessionId: 'limited',
              startedAt: new Date(2026, 9, 26, 16, 1).getTime(),
              endedAt: new Date(2026, 9, 26, 16, 2).getTime(),
              error: LOOK_FAILURES.unfinished,
              usageLimited: { resetsAt: new Date(2026, 9, 26, 16, 30).getTime() }
            }
          ]
        },
        result: null
      }))
      h.setNow(new Date(2026, 9, 26, 16, 31).getTime())
      return h
    }
    const continued = limitedLook(true)
    await continued.runner.tick()
    // A look records its run as it starts, before any await.
    expect(continued.store.get('b1').runs).toHaveLength(1)
    const owed = limitedLook(false)
    await owed.runner.tick()
    await vi.waitFor(() => expect(owed.sessions.startConversation).toHaveBeenCalledTimes(1))
  })

  it("starts the next day's look even though the limited look's chat moved on", async () => {
    const h = harness({ turn: success, continues: true })
    h.store.update('b1', (state) => ({
      state: {
        ...state,
        armedAt: new Date(2026, 9, 20, 9).getTime(),
        runs: [
          {
            sessionId: 'limited',
            startedAt: new Date(2026, 9, 26, 16, 1).getTime(),
            endedAt: new Date(2026, 9, 26, 16, 2).getTime(),
            error: LOOK_FAILURES.unfinished,
            usageLimited: { resetsAt: new Date(2026, 9, 26, 16, 30).getTime() }
          }
        ]
      },
      result: null
    }))
    h.setNow(new Date(2026, 9, 27, 12, 1).getTime())
    await h.runner.tick()
    expect(h.store.get('b1').runs).toHaveLength(2)
  })

  it('records a failed turn as notified only when it was news, and never a look that could not start', async () => {
    const { runner, store } = harness({ turn: { outcome: 'failure', message: 'limit' } })
    store.update('b1', (state) => ({
      state: {
        ...state,
        runs: [
          {
            sessionId: 'never-started',
            startedAt: 0,
            endedAt: 1,
            error: LOOK_FAILURES.couldNotStart
          }
        ]
      },
      result: null
    }))
    runner.lookNow('b1')
    await vi.waitFor(() => expect(store.get('b1').runs).toHaveLength(2))
    await vi.waitFor(() => expect(store.get('b1').runs[1]?.endedAt).toBeDefined())
    expect(store.get('b1').runs[1]).toMatchObject({
      error: LOOK_FAILURES.unfinished,
      alerted: true
    })
    runner.lookNow('b1')
    await vi.waitFor(() => expect(store.get('b1').runs[2]?.endedAt).toBeDefined())
    expect(store.get('b1').runs[2]?.alerted).toBeUndefined()
  })
})

describe('a look at its run limit', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops the look on its host after 10 minutes and records why', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const { runner, store, stopTurn } = harness()
    runner.lookNow('b1')
    // Recorded, and its ten minutes started, before Look now returns.
    expect(store.get('b1').runs).toHaveLength(1)
    const { sessionId } = store.get('b1').runs[0]!
    await vi.advanceTimersByTimeAsync(LOOK_RUN_LIMIT_MS - 1)
    expect(stopTurn).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(stopTurn).toHaveBeenCalledWith(sessionId)
    expect(store.get('b1').runs[0]?.error).toBe('The last look was stopped after 10 min.')
    expect(store.get('b1').runs[0]?.alerted).toBeUndefined()
  })

  it('keeps its slot until the stop is confirmed, so no other look starts alongside it', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const { runner, store, stopTurn, endTurn, setNow, sessions, setHostRunning } = harness({
      stopsToIdle: Infinity
    })
    runner.lookNow('b1')
    await vi.waitFor(() => expect(store.get('b1').runs).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(LOOK_RUN_LIMIT_MS)
    expect(stopTurn).toHaveBeenCalledTimes(1)

    // Still stopping: the look stays open and holds its slot against Look now and the schedule.
    expect(runner.lookNow('b1')).toEqual({ refused: 'running' })
    setNow(new Date(2026, 9, 26, 16, 1).getTime())
    await runner.tick()
    expect(sessions.startConversation).toHaveBeenCalledTimes(1)
    expect(store.get('b1').runs[0]?.endedAt).toBeUndefined()

    // A turn that outlasts the grace is asked to stop again.
    await vi.advanceTimersByTimeAsync(LOOK_STOP_GRACE_MS)
    expect(stopTurn).toHaveBeenCalledTimes(2)
    expect(runner.lookNow('b1')).toEqual({ refused: 'running' })

    // A turn end the watcher reports is not enough while the host still runs the look.
    endTurn({ unavailable: 'unread' })
    await vi.advanceTimersByTimeAsync(LOOK_STOP_GRACE_MS - 1)
    expect(store.get('b1').runs[0]?.endedAt).toBeUndefined()
    setHostRunning(false)
    await vi.advanceTimersByTimeAsync(LOOK_STOP_GRACE_MS)
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(store.get('b1').runs[0]?.error).toBe(LOOK_FAILURES.timedOut)
    expect(runner.lookNow('b1')).toEqual({ started: true })
  })

  it('frees the slot once the host is idle even when its Stop never answers', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const { runner, store, stopTurn, setHostRunning } = harness({ stopHangs: true })
    runner.lookNow('b1')
    await vi.waitFor(() => expect(store.get('b1').runs).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(LOOK_RUN_LIMIT_MS + LOOK_STOP_GRACE_MS)
    expect(stopTurn).toHaveBeenCalledTimes(1)
    expect(store.get('b1').runs[0]?.endedAt).toBeUndefined()
    setHostRunning(false)
    await vi.advanceTimersByTimeAsync(LOOK_STOP_GRACE_MS)
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
  })
})

describe("Look around's model", () => {
  // The owner last picked Opus in some chat; Settings > Agents says Haiku.
  const settings = {
    agentLaunchChoices: { claude: { model: 'claude-haiku-5-5' } },
    nativeChatSessionOptions: { claude: { model: 'claude-opus-5-5' } }
  }
  const runtime = {
    bots: { list: () => [] },
    requireStore: () => ({ getSettings: () => settings })
  }

  async function lookOnce(bot: Partial<Bot>): Promise<Record<string, string>> {
    vi.mocked(startBotSession).mockClear()
    const base = harness({ bot, turn: success })
    // The runtime's own sessions, so the look starts the way it does in Orca.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub covers what a look's start reaches.
    const sessions = runtimeBotAutomationSessions(runtime as unknown as OrcaRuntimeService)
    const runner = new BotLookAroundRunner({
      bots: () => [makeTestBot({ id: 'b1', agent: 'claude', ...bot })],
      store: base.store,
      hadConversation: async () => true,
      sessions,
      turnOff: async () => {},
      stopTurn: async () => {},
      turnRunning: () => false,
      usageLimitOf: async () => null,
      usageLimitContinues: async () => false,
      watchTurns: async () => ({
        next: () => Promise.resolve(success),
        dispose: () => {}
      }),
      power: base.host.power,
      now: () => MONDAY_NOON
    })
    expect(runner.lookNow('b1')).toEqual({ started: true })
    await vi.waitFor(() => expect(base.store.get('b1').runs[0]?.endedAt).toBeDefined())
    const [, started, input] = vi.mocked(startBotSession).mock.calls[0] ?? []
    expect(input).toMatchObject({ background: true })
    return botStartOptions(() => settings, started!, input?.background === true)
  }

  it("runs on the bot's own model when it has one", async () => {
    const options = await lookOnce({ launch: { model: 'claude-sonnet-5-5' } })
    expect(options).toEqual({ model: 'claude-sonnet-5-5' })
  })

  it("otherwise runs on the owner's Agents default, never their last chat pick", async () => {
    const options = await lookOnce({})
    expect(options).toEqual({ model: 'claude-haiku-5-5' })
    expect(options.model).not.toBe('claude-opus-5-5')
  })
})

describe('a look on a sleeping host', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const at = (hour: number, minute = 0) => new Date(2026, 9, 26, hour, minute).getTime()
  const armedLastWeek = (store: BotLookAroundStore) =>
    store.update('b1', (state) => ({
      state: { ...state, armedAt: new Date(2026, 9, 19, 9).getTime() },
      result: null
    }))

  it('waits for a settled full wake, then catches the slot up once', async () => {
    const { runner, store, sessions, setNow, host } = harness({
      turn: success
    })
    armedLastWeek(store)
    // 08:00 comes while the host is in a dark wake: nothing starts, and the slot stays open.
    host.setSettled(false)
    setNow(at(8, 1))
    await runner.tick()
    expect(sessions.startConversation).not.toHaveBeenCalled()
    expect(store.get('b1').runs).toHaveLength(0)

    host.setSettled(true)
    host.setFullWake(false)
    setNow(at(8, 10))
    await runner.tick()
    expect(sessions.startConversation).not.toHaveBeenCalled()
    expect(store.get('b1').runs).toHaveLength(0)

    // Opened at 9:40, past the hour a missed slot used to wait: it still runs, once.
    host.setFullWake(true)
    setNow(at(9, 40))
    await runner.tick()
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    await runner.tick()
    expect(sessions.startConversation).toHaveBeenCalledTimes(1)
  })

  it('records a look the host slept through as missed, not failed, and tries the slot again', async () => {
    const { runner, store, sessions, setNow, host, endTurn, turnOff } = harness()
    armedLastWeek(store)
    setNow(at(8, 1))
    await runner.tick()
    await vi.waitFor(() => expect(sessions.startConversation).toHaveBeenCalledTimes(1))
    const { sessionId } = store.get('b1').runs[0]!
    expect(store.lookTurnIsQuiet(sessionId, 'failure')).toBe(false)
    // The host sleeps 30 minutes; the provider's connection dies with it. Its turn's end is no
    // news, before the look is recorded and after.
    host.sleep(30 * 60_000)
    expect(store.lookTurnIsQuiet(sessionId, 'failure')).toBe(true)
    endTurn({
      outcome: 'failure',
      message: 'Connection lost while your computer was asleep'
    })
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(store.get('b1').runs[0]).toMatchObject({
      error: LOOK_FAILURES.asleep,
      asleep: true
    })
    expect(store.lookTurnIsQuiet(sessionId, 'failure')).toBe(true)
    expect(store.get('b1').runs[0]?.alerted).toBeUndefined()
    expect(turnOff).not.toHaveBeenCalled()

    setNow(at(8, 40))
    await runner.tick()
    await vi.waitFor(() => expect(sessions.startConversation).toHaveBeenCalledTimes(2))
  })

  it('counts its limit in awake time, and holds the host awake only while it runs', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const { runner, store, stopTurn, host } = harness()
    runner.lookNow('b1')
    // Recorded, and its ten minutes started, before Look now returns.
    expect(store.get('b1').runs).toHaveLength(1)
    expect(host.holds).toEqual({ taken: 1, released: 0 })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    // Asleep for an hour: its timers fire on waking, but none of that time counts.
    host.sleep(60 * 60_000)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(stopTurn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(LOOK_RUN_LIMIT_MS - 5 * 60_000 - 1)
    expect(stopTurn).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(stopTurn).toHaveBeenCalledTimes(1)
    // It slept and never finished: missed, not "stopped after 10 min".
    expect(store.get('b1').runs[0]?.error).toBe(LOOK_FAILURES.asleep)
    expect(host.holds).toEqual({ taken: 1, released: 1 })
  })

  it('takes a look back, slot and all, when the host leaves full wake while its session is made', async () => {
    let dark = true
    const ctx: { h?: ReturnType<typeof harness> } = {}
    const h = harness({ turn: success, preparing: () => ctx.h!.host.setFullWake(!dark) })
    ctx.h = h
    armedLastWeek(h.store)
    h.setNow(at(8, 1))
    await h.runner.tick()
    await vi.waitFor(() => expect(h.sessions.release).toHaveBeenCalledTimes(1))
    const sessionId = h.sessions.release.mock.calls[0]![0]
    expect(h.store.get('b1').runs).toHaveLength(0)
    // Its session stays known as a look's, never a chat.
    expect(h.store.botOfLook(sessionId)).toBe('b1')
    expect(h.turnOff).not.toHaveBeenCalled()

    dark = false
    h.host.setFullWake(true)
    h.setNow(at(8, 5))
    await h.runner.tick()
    await vi.waitFor(() => expect(h.store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(h.store.get('b1').runs[0]?.error).toBeUndefined()
  })

  it('takes a look back when Look around is turned off while its session is made', async () => {
    const ctx: { h?: ReturnType<typeof harness> } = {}
    const h = harness({
      turn: success,
      preparing: () => ctx.h!.setBot({ lookAround: { ...LOOK_AROUND_DEFAULTS, on: false } })
    })
    ctx.h = h
    armedLastWeek(h.store)
    h.setNow(at(8, 1))
    await h.runner.tick()
    await vi.waitFor(() => expect(h.sessions.release).toHaveBeenCalledTimes(1))
    expect(h.store.get('b1').runs).toHaveLength(0)
  })

  it('never holds back Look now, whatever the power', async () => {
    const { runner, store, host } = harness({ turn: success })
    host.setFullWake(false)
    expect(runner.lookNow('b1')).toEqual({ started: true })
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(store.get('b1').runs[0]?.error).toBeUndefined()
  })

  it('records a look cut short by a short reported suspend as missed', async () => {
    const { runner, store, sessions, setNow, host, endTurn } = harness()
    armedLastWeek(store)
    setNow(at(8, 1))
    await runner.tick()
    await vi.waitFor(() => expect(sessions.startConversation).toHaveBeenCalledTimes(1))
    host.suspend()
    endTurn({ outcome: 'failure', message: 'Connection lost while your computer was asleep' })
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(store.get('b1').runs[0]).toMatchObject({ error: LOOK_FAILURES.asleep, asleep: true })
  })

  it('bounds a start that stalls before its prompt, and refuses that prompt if it comes late', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const { runner, store, hooks, sessions } = harness({ startHangs: 'before-send' })
    runner.lookNow('b1')
    await vi.waitFor(() => expect(hooks).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(LOOK_RUN_LIMIT_MS)
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(store.get('b1').runs[0]?.error).toBe(LOOK_FAILURES.timedOut)
    expect(sessions.release).toHaveBeenCalledTimes(1)
    // The stalled start reaching its opening message now sends nothing.
    await expect(Promise.resolve().then(() => hooks[0]?.())).rejects.toThrow()
  })

  it('stops a turn whose start sent its prompt and then hung, at the limit', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const { runner, store, stopTurn, setHostRunning } = harness({ startHangs: 'after-send' })
    runner.lookNow('b1')
    // Recorded, and its ten minutes started, before Look now returns.
    expect(store.get('b1').runs).toHaveLength(1)
    const { sessionId } = store.get('b1').runs[0]!
    await vi.advanceTimersByTimeAsync(LOOK_RUN_LIMIT_MS - 1)
    expect(stopTurn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(stopTurn).toHaveBeenCalledWith(sessionId))
    setHostRunning(false)
    await vi.advanceTimersByTimeAsync(LOOK_STOP_GRACE_MS)
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(store.get('b1').runs[0]?.error).toBe(LOOK_FAILURES.timedOut)
  })

  it('sends no prompt when the limit passes while its full-wake check is still reading', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const read = Promise.withResolvers<boolean>()
    const ctx: { h?: ReturnType<typeof harness> } = {}
    const h = harness({
      // The opening-message check's read hangs past the limit, then says full wake.
      preparing: () => ctx.h!.host.setFullWakeRead(() => read.promise)
    })
    ctx.h = h
    armedLastWeek(h.store)
    h.setNow(at(8, 1))
    await h.runner.tick()
    await vi.waitFor(() => expect(h.hooks).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(LOOK_RUN_LIMIT_MS)
    await vi.waitFor(() => expect(h.store.get('b1').runs[0]?.endedAt).toBeDefined())
    // The read now says full wake, after the look was recorded as stopped: still nothing is sent.
    read.resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent).toEqual([])
    expect(h.store.get('b1').runs[0]?.error).toBe(LOOK_FAILURES.timedOut)
  })

  it('stops a turn whose start returns only after the limit', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const returns = Promise.withResolvers<void>()
    const { runner, store, stopTurn, setHostRunning } = harness({ startReturns: returns.promise })
    setHostRunning(false)
    runner.lookNow('b1')
    await vi.waitFor(() => expect(store.get('b1').runs).toHaveLength(1))
    const { sessionId } = store.get('b1').runs[0]!
    await vi.advanceTimersByTimeAsync(LOOK_RUN_LIMIT_MS)
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(stopTurn).not.toHaveBeenCalled()
    returns.resolve()
    await vi.waitFor(() => expect(stopTurn).toHaveBeenCalledWith(sessionId))
  })

  it('never delivers a prompt whose append lands after the limit, once the look is over', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const append = Promise.withResolvers<void>()
    const { runner, store, sent, delivered, withdrawn, setHostRunning } = harness({
      appending: append.promise
    })
    // The host reads idle the whole time: nothing holds the look open at its limit.
    setHostRunning(false)
    runner.lookNow('b1')
    await vi.advanceTimersByTimeAsync(LOOK_RUN_LIMIT_MS)
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(store.get('b1').runs[0]?.error).toBe(LOOK_FAILURES.timedOut)
    // The append lands now, after cleanup: the delivery check withdraws it.
    append.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(1)
    expect(delivered).toEqual([])
    expect(withdrawn).toEqual(sent)
  })

  it('withdraws a scheduled prompt when the host sleeps between its admission and delivery, slot open', async () => {
    const ctx: { h?: ReturnType<typeof harness> } = {}
    // Admitted on a fresh full-wake read; the host sleeps and wakes while the append is in flight.
    const h = harness({ turn: success, beforeAppend: () => ctx.h!.host.suspend() })
    ctx.h = h
    armedLastWeek(h.store)
    h.setNow(at(8, 1))
    await h.runner.tick()
    await vi.waitFor(() => expect(h.sessions.release).toHaveBeenCalledTimes(1))
    expect(h.withdrawn).toHaveLength(1)
    expect(h.delivered).toEqual([])
    expect(h.store.get('b1').runs).toHaveLength(0)
  })

  it('bounds a host whose turn watch never comes, from when the look is recorded and held awake', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const ready = Promise.withResolvers<void>()
    const { runner, store, sessions, host, watches } = harness({ watchReady: ready.promise })
    runner.lookNow('b1')
    expect(host.holds).toEqual({ taken: 1, released: 0 })
    await vi.advanceTimersByTimeAsync(LOOK_RUN_LIMIT_MS)
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(store.get('b1').runs[0]?.error).toBe(LOOK_FAILURES.timedOut)
    expect(host.holds).toEqual({ taken: 1, released: 1 })
    // The watch comes late: it is let go, and nothing starts.
    ready.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(watches.disposed).toBe(1)
    expect(sessions.startConversation).not.toHaveBeenCalled()
  })

  it('keeps tracking sleep through a stop at the limit that is slow to land', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const { runner, store, stopTurn, host, setHostRunning } = harness({ stopsToIdle: Infinity })
    runner.lookNow('b1')
    await vi.waitFor(() => expect(store.get('b1').runs).toHaveLength(1))
    const { sessionId } = store.get('b1').runs[0]!
    await vi.advanceTimersByTimeAsync(LOOK_RUN_LIMIT_MS)
    expect(stopTurn).toHaveBeenCalledTimes(1)
    // The host sleeps while the stop is still landing: the turn's end is no news, and the look
    // is missed, not stopped after ten minutes.
    host.suspend()
    expect(store.lookTurnIsQuiet(sessionId, 'failure')).toBe(true)
    setHostRunning(false)
    await vi.advanceTimersByTimeAsync(LOOK_STOP_GRACE_MS)
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(store.get('b1').runs[0]).toMatchObject({ error: LOOK_FAILURES.asleep, asleep: true })
    expect(store.get('b1').runs[0]?.alerted).toBeUndefined()
  })

  it('stops a turn whose prompt went through before its start failed, before the look lets go', async () => {
    const { runner, store, stopTurn, delivered } = harness({ failAfterDelivery: true })
    runner.lookNow('b1')
    const { sessionId } = store.get('b1').runs[0]!
    await vi.waitFor(() => expect(store.get('b1').runs[0]?.endedAt).toBeDefined())
    expect(delivered).toEqual([sessionId])
    expect(stopTurn).toHaveBeenCalledWith(sessionId)
    expect(store.get('b1').runs[0]?.error).toBe(LOOK_FAILURES.couldNotStart)
  })
})
