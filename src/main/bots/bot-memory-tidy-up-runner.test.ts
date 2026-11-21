import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { makeTestBot } from './bot.test-fixture'
import { BotLookAroundStore } from './bot-look-around-store'
import { createBotMemoryHistory } from './bot-memory-history'
import { createBotMemoryRecord, tagBotMemoryFile } from './bot-memory-record'
import { TIDY_UP_FAILURES, type TidyUpChat } from './bot-memory-tidy-up'
import { ASLEEP_RETRY_AFTER_MS } from './bot-look-around-state'
import { BotTidyUpRunner } from './bot-memory-tidy-up-runner'
import { testRunPower } from './bot-background-run.test-fixture'
import type { BotTurnEnd } from './bot-run-turn-watch'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { memorySnapshot } from './bot-memory-ops'
import { TIDY_UP_OPS_PILOT_FILE } from './bot-memory-ops-pilot'
import { readdGuard } from './bot-memory-readd-guard'

const HOME = '/home/me/.orca/bots/scout'
const MEMORY = join(HOME, 'MEMORY.md')
const ARCHIVE = join(HOME, 'memory', 'archive.md')
const RELEASE = join(HOME, 'memory', 'release.md')
const NIGHT = new Date(2026, 10, 6, 3, 5).getTime()
const DAY = 24 * 60 * 60 * 1000
const OWNER_CHAT: TidyUpChat = {
  title: 'Release prep',
  lines: [{ by: 'owner', text: 'Releases moved to Wednesdays' }]
}
const KEPT = [
  '- 2026-10-02 times in Eastern',
  '- 2026-10-04 staging is on Thursdays',
  '- 2026-10-05 notes never name other products',
  '- 2026-10-06 PRs open ready, not draft',
  '- 2026-10-07 owner reviews UX changes',
  '- 2026-10-08 no tinted rows',
  '- 2026-10-09 estimates at build pace',
  '- 2026-10-10 links use full paths'
]
const TUESDAYS = '- 2026-10-01 releases go out on Tuesdays'
const BEFORE = [
  '# Memory',
  TUESDAYS,
  KEPT[0],
  '- 2026-10-03 times are in Eastern',
  ...KEPT.slice(1),
  ''
].join('\n')
const INDEX = ['# Memory', ...KEPT, '- 2026-11-06 releases go out on Wednesdays'].join('\n')
const reply = (index: string, ...blocks: string[]): string =>
  ['Here it is.', 'BEGIN MEMORY.md', index, 'END MEMORY.md', ...blocks].join('\n')
const REPLACED = `BEGIN REPLACED\n${TUESDAYS}\nEND REPLACED`

function harness(
  options: {
    memory?: string
    chats?: TidyUpChat[]
    reply?: string
    duringRun?: (files: Map<string, string>) => void
    failWrite?: string
    busyAfterChats?: boolean
    bot?: Partial<Bot>
    /** Replaces the chat read, e.g. to hold it open or fail it. */
    readChats?: () => Promise<TidyUpChat[]>
    /** While the session is made, before its opening message is admitted. */
    preparing?: () => void
    /** Between the opening message's admission and its append, after which delivery starts. */
    beforeAppend?: () => void
    /** Replaces the run's turn end, e.g. to sleep the host through it. */
    turnEnd?: () => Promise<BotTurnEnd>
  } = {}
) {
  let now = NIGHT
  const host = testRunPower(() => now)
  const files = new Map([[MEMORY, options.memory ?? BEFORE]])
  const write = (path: string, text: string): boolean => {
    if (path === options.failWrite) {
      throw new Error('EACCES')
    }
    files.set(path, text)
    return true
  }
  const fs = {
    readText: async (path: string) => files.get(path) ?? null,
    replaceText: async (path: string, expected: string, text: string) =>
      files.get(path) === expected && write(path, text),
    writeText: async (path: string, text: string, opts?: { exclusive?: boolean }) =>
      !(opts?.exclusive && files.has(path)) && write(path, text),
    makeDirectory: async () => {}
  }
  const stored = new Map<string, string>()
  const history = createBotMemoryHistory(
    {
      read: async (id) => stored.get(id) ?? null,
      write: async (id, text) => void (text === null ? stored.delete(id) : stored.set(id, text)),
      bots: async () => [...stored.keys()]
    },
    () => now
  )
  const memory = createBotMemoryRecord(fs, history)
  let bot = makeTestBot({ id: 'b1', agent: 'claude', ...options.bot })
  let busy = false
  const store = new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {})
  const startConversation = vi.fn(
    async (
      _bot: Bot,
      input: {
        sessionId?: string
        beforeFirstMessage?: () => void | Promise<void>
        beforeDelivery?: () => boolean
      }
    ) => {
      options.duringRun?.(files)
      // The session is made, then admitted right before its opening message, as Orca's create does.
      options.preparing?.()
      await input.beforeFirstMessage?.()
      options.beforeAppend?.()
      // After the append, the caller's last word before delivery.
      ;(input.beforeDelivery?.() === false ? withdrawn : delivered).push(input.sessionId ?? 's')
      return { sessionId: input.sessionId ?? 's', clientMessageId: 'm', fingerprint: 'f' }
    }
  )
  const release = vi.fn(async (_sessionId: string) => undefined)
  const delivered: string[] = []
  const withdrawn: string[] = []
  const turnOff = vi.fn(async (_bot: Bot, _lastError: string) => {
    bot = { ...bot, tidyUp: { on: false } }
  })
  const noteTidied = vi.fn()
  const runner = new BotTidyUpRunner({
    bots: () => [bot],
    store,
    newChats: async () => {
      if (options.readChats) {
        return options.readChats()
      }
      busy = options.busyAfterChats === true
      return options.chats ?? [OWNER_CHAT]
    },
    busy: () => busy,
    memory,
    fs,
    memoryFiles: async () => [],
    homeFolder: () => HOME,
    sessions: { startConversation, release },
    watchTurns: async () => ({
      next: async () =>
        options.turnEnd
          ? options.turnEnd()
          : { outcome: 'success' as const, message: options.reply ?? reply(INDEX, REPLACED) },
      dispose: () => {}
    }),
    stopTurn: async () => {},
    turnRunning: () => false,
    turnOff,
    noteTidied,
    power: host.power,
    now: () => now
  })
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await memory.after('b1', async () => undefined)
  }
  return {
    runner,
    fs,
    host,
    release,
    delivered,
    withdrawn,
    setBusy: (value: boolean) => (busy = value),
    files,
    startConversation,
    turnOff,
    noteTidied,
    last: () => store.get('b1').tidyUp?.last,
    rows: () => history.list('b1'),
    runs: () => store.get('b1').tidyUp?.runs ?? [],
    through: () => store.get('b1').tidyUp?.through,
    /** A tick, and the run it starts, to its end: every step here settles on the task queue. */
    tick: async () => {
      await runner.tick()
      await settle()
    },
    tidyNow: async () => {
      const outcome = runner.tidyNow('b1')
      await settle()
      return outcome
    },
    setNow: (time: number) => (now = time),
    setBot: (patch: Partial<Bot>) => (bot = { ...bot, ...patch }),
    now: () => now
  }
}

describe('Tidy-up', () => {
  it('applies its draft as one History row, archiving what it left out before MEMORY.md loses it', async () => {
    const { files, rows, tick } = harness()
    await tick()

    expect(files.get(MEMORY)).toBe(`${INDEX}\n`)
    expect(await rows()).toHaveLength(1)
    expect((await rows())[0]).toMatchObject({ by: { kind: 'tidy-up' }, undoable: true })
    expect(files.get(ARCHIVE)).toBe(
      [
        '# Archive',
        '- 2026-10-01 ~~releases go out on Tuesdays~~ · replaced 2026-11-06',
        '- 2026-10-03 times are in Eastern · moved 2026-11-06',
        ''
      ].join('\n')
    )
  })

  it('files details into a topic file and keeps them out of the archive', async () => {
    const pointer = '- 2026-11-06 Release steps and lessons: memory/release.md'
    const index = [
      '# Memory',
      TUESDAYS,
      KEPT[0],
      '- 2026-10-03 times are in Eastern',
      ...KEPT.slice(1, 6),
      pointer
    ]
    const topic = ['# Release steps and lessons', ...KEPT.slice(6)].join('\n')
    const { files, tick } = harness({
      reply: reply(index.join('\n'), `BEGIN memory/release.md\n${topic}\nEND memory/release.md`)
    })
    await tick()

    expect(files.get(MEMORY)).toBe(`${index.join('\n')}\n`)
    expect(files.get(RELEASE)).toBe(`${topic}\n`)
    expect(files.has(ARCHIVE)).toBe(false)
  })

  it('refuses to file a fact MEMORY.md never had, writing no topic file', async () => {
    const pointer = '- 2026-11-06 Release steps: memory/release.md'
    const { files, rows, runs, tick } = harness({
      reply: reply(
        `${INDEX}\n${pointer}`,
        REPLACED,
        'BEGIN memory/release.md\n# Release steps\n- 2026-11-06 production is public\nEND memory/release.md'
      )
    })
    await tick()

    expect(files.get(MEMORY)).toBe(BEFORE)
    expect(files.has(RELEASE)).toBe(false)
    expect(await rows()).toEqual([])
    expect(runs()[0].error).toBe(
      "The last tidy-up filed a line MEMORY.md doesn't have; new facts go in MEMORY.md, so nothing changed."
    )
  })

  it('changes nothing and keeps its chats for the next night when the archive cannot be written', async () => {
    const { files, rows, runs, through, tick } = harness({ failWrite: ARCHIVE })
    await tick()

    expect(files.get(MEMORY)).toBe(BEFORE)
    expect(await rows()).toEqual([])
    expect(runs()[0].error).toBe(
      "The last tidy-up's changes couldn't be saved, so nothing changed."
    )
    expect(through()).toBeUndefined()
  })

  it("lets a chat's correction made while it ran win over its stale replacement", async () => {
    const { files, runs, tick } = harness({
      duringRun: (live) =>
        live.set(MEMORY, BEFORE.replace(TUESDAYS, '- 2026-11-06 releases go out on Thursdays'))
    })
    await tick()

    expect(files.get(MEMORY)).toBe(
      BEFORE.replace(TUESDAYS, '- 2026-11-06 releases go out on Thursdays')
    )
    expect(runs()[0].error).toBe('MEMORY.md changed during the last tidy-up, so nothing changed.')
  })

  it('keeps a fact once when its draft drops a repeat of it', async () => {
    const memory = `# Memory\n${KEPT[0]}\n${KEPT[0]}\n${KEPT.slice(1).join('\n')}\n`
    const { files, tick } = harness({ memory, reply: reply(['# Memory', ...KEPT].join('\n')) })
    await tick()

    expect(files.get(MEMORY)).toBe(`${['# Memory', ...KEPT].join('\n')}\n`)
  })

  it('does not start when an owner turn began while it read the chats', async () => {
    const { startConversation, tick } = harness({ busyAfterChats: true })
    await tick()

    expect(startConversation).not.toHaveBeenCalled()
  })

  it('turns itself off after 10 failed nights in a row, and then stays off', async () => {
    const { setNow, startConversation, tick, turnOff } = harness({
      reply: reply('# Memory\n- 2026-10-02 times in Eastern')
    })
    for (let night = 0; night < 11; night += 1) {
      setNow(NIGHT + night * DAY)
      await tick()
    }

    expect(startConversation).toHaveBeenCalledTimes(10)
    expect(turnOff).toHaveBeenCalledTimes(1)
    expect(turnOff.mock.calls[0][1]).toBe(
      'The last tidy-up took out too many lines at once, so nothing changed.'
    )
  })

  it('runs once a night after 3 AM, and only when the owner had new chats', async () => {
    const quiet = harness({ chats: [] })
    quiet.setNow(new Date(2026, 10, 6, 2, 59).getTime())
    await quiet.tick()
    quiet.setNow(NIGHT)
    await quiet.tick()
    expect(quiet.startConversation).not.toHaveBeenCalled()

    const active = harness()
    await active.tick()
    active.setNow(NIGHT + 60 * 60 * 1000)
    await active.tick()
    expect(active.startConversation).toHaveBeenCalledTimes(1)
    active.setNow(NIGHT + DAY)
    await active.tick()
    expect(active.startConversation).toHaveBeenCalledTimes(2)
  })

  it('keeps a summary of what it changed and says so once in the Home Chat', async () => {
    const { last, noteTidied, rows, tick } = harness()
    await tick()

    expect(last()).toMatchObject({
      chats: 1,
      rowId: (await rows())[0].id,
      learned: ['releases go out on Wednesdays'],
      replaced: ['releases go out on Tuesdays'],
      filed: [],
      moved: 1,
      merged: 0
    })
    expect(noteTidied).toHaveBeenCalledTimes(1)
    expect(noteTidied.mock.calls[0][1]).toEqual({ botId: 'b1', changes: 3 })
  })

  it('tidies now with no new chats, again right after, but not while one runs', async () => {
    const { runner, setNow, startConversation, tidyNow } = harness({ chats: [] })
    setNow(new Date(2026, 10, 6, 14, 0).getTime())
    expect(runner.tidyNow('b1')).toEqual({ started: true })
    expect(await tidyNow()).toEqual({ refused: 'running' })
    expect(await tidyNow()).toEqual({ started: true })
    expect(startConversation).toHaveBeenCalledTimes(2)
  })

  it('once a week, skips the six nights after one that applied', async () => {
    const { setNow, startConversation, tick } = harness({
      bot: { tidyUp: { on: true, every: 'week' } }
    })
    for (let night = 0; night < 8; night += 1) {
      setNow(NIGHT + night * DAY)
      await tick()
    }
    expect(startConversation).toHaveBeenCalledTimes(2)
  })

  it('never starts a second run while a scheduled one is still reading its chats', async () => {
    const read = Promise.withResolvers<TidyUpChat[]>()
    let reading = false
    const { runner, setNow, startConversation, tick } = harness({
      readChats: () => ((reading = true), read.promise)
    })
    const ticked = tick()
    await vi.waitFor(() => expect(reading).toBe(true))
    setNow(NIGHT + 1)
    expect(runner.tidyNow('b1')).toEqual({ refused: 'running' })
    read.resolve([OWNER_CHAT])
    await ticked
    await tick()

    expect(startConversation).toHaveBeenCalledTimes(1)
  })

  it('keeps its chats for later when it could not read them', async () => {
    const { startConversation, through, runs, tidyNow } = harness({
      readChats: async () => {
        throw new Error('host unavailable')
      }
    })
    await tidyNow()

    expect(startConversation).not.toHaveBeenCalled()
    expect(through()).toBeUndefined()
    expect(runs()[0].error).toBe("The last tidy-up couldn't read its chats, so it didn't run.")
  })

  it('says nothing in the Home Chat when filing again changed no file', async () => {
    const memory = ['# Memory', ...KEPT, ''].join('\n')
    const filing = reply(
      ['# Memory', ...KEPT].join('\n'),
      `BEGIN memory/style.md\n# Style\n${KEPT[7]}\nEND memory/style.md`
    )
    const { files, noteTidied, setNow, tidyNow } = harness({ memory, reply: filing, chats: [] })
    setNow(new Date(2026, 10, 6, 14, 0).getTime())
    await tidyNow()
    const after = new Map(files)
    setNow(new Date(2026, 10, 6, 14, 11).getTime())
    await tidyNow()

    expect(files).toEqual(after)
    expect(noteTidied).toHaveBeenCalledTimes(1)
  })
})

describe('Tidy-up on a sleeping host', () => {
  const HOUR = 60 * 60 * 1000
  const asleepEnd = (sleep: (ms: number) => void, advance: (ms: number) => void) => async () => {
    // The host sleeps half an hour mid-run, and the provider's connection dies with it.
    sleep(30 * 60_000)
    advance(30 * 60_000)
    return {
      outcome: 'failure' as const,
      message: 'Connection lost while your computer was asleep'
    }
  }

  it('never starts in a dark wake, and starts on the first awake tick after', async () => {
    const { host, setNow, startConversation, tick, through } = harness()
    host.setSettled(false)
    await tick()
    expect(startConversation).not.toHaveBeenCalled()
    expect(through()).toBeUndefined()

    host.setSettled(true)
    setNow(NIGHT + 20 * 60_000)
    await tick()
    expect(startConversation).toHaveBeenCalledTimes(1)
    expect(through()).toBeDefined()
  })

  it('catches up a night the host slept through on its first awake tick, then waits for the next night', async () => {
    // A bot from before Tidy-up kept when it was turned on counts as on since it was made: its
    // first tick after the upgrade, at 10:30 past a night it slept through, catches that night up.
    const { setNow, startConversation, tick } = harness()
    setNow(NIGHT + 7.5 * HOUR)
    await tick()
    expect(startConversation).toHaveBeenCalledTimes(1)
    setNow(NIGHT + 12 * HOUR)
    await tick()
    setNow(NIGHT + DAY - 10 * 60_000)
    await tick()
    expect(startConversation).toHaveBeenCalledTimes(1)
    setNow(NIGHT + DAY)
    await tick()
    expect(startConversation).toHaveBeenCalledTimes(2)
  })

  it("records a run the host's sleep cut short as missed, keeps its chats, and tries again once awake", async () => {
    let asleep = true
    const ctx: { h?: ReturnType<typeof harness> } = {}
    const h = harness({
      turnEnd: async () =>
        asleep
          ? asleepEnd(ctx.h!.host.sleep, (ms) => ctx.h!.setNow(ctx.h!.now() + ms))()
          : { outcome: 'success', message: reply(INDEX, REPLACED) }
    })
    ctx.h = h
    await h.tick()
    expect(h.runs()).toHaveLength(1)
    expect(h.runs()[0]).toMatchObject({
      error: TIDY_UP_FAILURES.asleep,
      asleep: true
    })
    expect(h.runs()[0].alerted).toBeUndefined()
    expect(h.through()).toBeUndefined()

    // It waits a little after a run sleep cut short, then takes the same night.
    asleep = false
    h.setNow(h.now() + 5 * 60_000)
    await h.tick()
    expect(h.startConversation).toHaveBeenCalledTimes(1)
    h.setNow(h.now() + ASLEEP_RETRY_AFTER_MS)
    await h.tick()
    expect(h.startConversation).toHaveBeenCalledTimes(2)
    expect(h.runs()[1].error).toBeUndefined()
    expect(h.through()).toBeDefined()
  })

  it('never gives up a night sleep keeps cutting short, and never turns itself off for it', async () => {
    let cut = 0
    const ctx: { h?: ReturnType<typeof harness> } = {}
    const h = harness({
      turnEnd: async () =>
        cut++ < 12
          ? asleepEnd(ctx.h!.host.sleep, (ms) => ctx.h!.setNow(ctx.h!.now() + ms))()
          : { outcome: 'success', message: reply(INDEX, REPLACED) }
    })
    ctx.h = h
    // Twelve runs in a row cut short through the night and morning, each tried again a quarter
    // hour after the last; the thirteenth, once the host stays awake, applies.
    for (let attempt = 0; attempt < 13; attempt += 1) {
      await h.tick()
      h.setNow(h.now() + ASLEEP_RETRY_AFTER_MS)
    }
    expect(h.startConversation).toHaveBeenCalledTimes(13)
    expect(h.turnOff).not.toHaveBeenCalled()
    expect(h.through()).toBeDefined()
  })

  it('counts a draft Orca refused, or one it could not write, as missed when the host slept, and keeps its chats', async () => {
    const options: Parameters<typeof harness>[0] = { failWrite: ARCHIVE }
    const ctx: { h?: ReturnType<typeof harness> } = {}
    options.turnEnd = async () => {
      ctx.h!.host.suspend()
      return { outcome: 'success', message: reply(INDEX, REPLACED) }
    }
    const h = harness(options)
    ctx.h = h
    await h.tick()
    expect(h.runs()[0]).toMatchObject({ error: TIDY_UP_FAILURES.asleep, asleep: true })
    // Nothing was written: the archive goes first, so MEMORY.md never lost a line.
    expect(h.files.get(MEMORY)).toBe(BEFORE)
    expect(h.through()).toBeUndefined()

    // The retry, with the write working again, applies the night once.
    options.failWrite = undefined
    options.turnEnd = undefined
    h.setNow(h.now() + ASLEEP_RETRY_AFTER_MS)
    await h.tick()
    expect(h.runs()[1].error).toBeUndefined()
    expect(await h.rows()).toHaveLength(1)
    expect(h.through()).toBeDefined()
  })

  it('never catches up a night it was not on for: a new or re-enabled Tidy-up waits for the night', async () => {
    // Made at 2 PM: it waits for the night's hours.
    const made = harness({ bot: { createdAt: NIGHT + 11 * HOUR } })
    made.setNow(NIGHT + 11 * HOUR)
    await made.tick()
    expect(made.startConversation).not.toHaveBeenCalled()
    made.setNow(NIGHT + DAY)
    await made.tick()
    expect(made.startConversation).toHaveBeenCalledTimes(1)

    // Turned off and back on between two ticks at 2 PM: turning it on stamped when, so no tick
    // ever saw it off, and it still waits for the night.
    const back = harness()
    back.setNow(NIGHT + 11 * HOUR)
    back.setBot({ tidyUp: { on: true, since: NIGHT + 11 * HOUR } })
    await back.tick()
    expect(back.startConversation).not.toHaveBeenCalled()
    back.setNow(NIGHT + DAY)
    await back.tick()
    expect(back.startConversation).toHaveBeenCalledTimes(1)
  })

  it('never starts in a dark wake that outlasts the settle, and starts once in full wake', async () => {
    const { host, setNow, startConversation, tick, runs } = harness()
    host.setFullWake(false)
    await tick()
    expect(startConversation).not.toHaveBeenCalled()
    expect(runs()).toHaveLength(0)
    host.setFullWake(true)
    setNow(NIGHT + 20 * 60_000)
    await tick()
    expect(startConversation).toHaveBeenCalledTimes(1)
  })

  it('takes a run back, slot and all, when the host leaves full wake while its session is made', async () => {
    let dark = true
    const ctx: { h?: ReturnType<typeof harness> } = {}
    const h = harness({ preparing: () => ctx.h!.host.setFullWake(!dark) })
    ctx.h = h
    await h.tick()
    expect(h.startConversation).toHaveBeenCalledTimes(1)
    expect(h.runs()).toHaveLength(0)
    expect(h.through()).toBeUndefined()
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.turnOff).not.toHaveBeenCalled()

    // The next awake tick takes the same night.
    dark = false
    h.host.setFullWake(true)
    h.setNow(NIGHT + 5 * 60_000)
    await h.tick()
    expect(h.runs()).toHaveLength(1)
    expect(h.through()).toBeDefined()
  })

  it('takes a run back when its bot is turned off while its session is made', async () => {
    const ctx: { h?: ReturnType<typeof harness> } = {}
    const h = harness({ preparing: () => ctx.h!.setBot({ tidyUp: { on: false } }) })
    ctx.h = h
    await h.tick()
    expect(h.runs()).toHaveLength(0)
    expect(h.through()).toBeUndefined()
  })

  it('records a run cut short by a short reported suspend as missed', async () => {
    const ctx: { h?: ReturnType<typeof harness> } = {}
    const h = harness({
      turnEnd: async () => {
        // A two-second sleep: too short for the awake clock to notice, but the system said so.
        ctx.h!.host.suspend()
        return { outcome: 'failure', message: 'Connection lost while your computer was asleep' }
      }
    })
    ctx.h = h
    await h.tick()
    expect(h.runs()[0]).toMatchObject({ error: TIDY_UP_FAILURES.asleep, asleep: true })
    expect(h.runs()[0].alerted).toBeUndefined()
  })

  it("withdraws a scheduled tidy-up's prompt when an owner turn begins before delivery, and tries the night again", async () => {
    let owner = true
    const ctx: { h?: ReturnType<typeof harness> } = {}
    const h = harness({ beforeAppend: () => owner && ctx.h!.setBusy(true) })
    ctx.h = h
    await h.tick()
    expect(h.withdrawn).toHaveLength(1)
    expect(h.delivered).toEqual([])
    expect(h.runs()).toHaveLength(0)
    expect(h.through()).toBeUndefined()
    expect(h.files.get(MEMORY)).toBe(BEFORE)

    owner = false
    h.setBusy(false)
    h.setNow(NIGHT + 5 * 60_000)
    await h.tick()
    expect(h.delivered).toHaveLength(1)
    expect(h.through()).toBeDefined()
  })

  it("withdraws a scheduled tidy-up's prompt when the host sleeps between admission and delivery", async () => {
    const ctx: { h?: ReturnType<typeof harness> } = {}
    const h = harness({ beforeAppend: () => ctx.h!.host.suspend() })
    ctx.h = h
    await h.tick()
    expect(h.withdrawn).toHaveLength(1)
    expect(h.delivered).toEqual([])
    expect(h.runs()).toHaveLength(0)
  })

  it('delivers Tidy now from a dark wake even if the host suspends before delivery', async () => {
    const ctx: { h?: ReturnType<typeof harness> } = {}
    const h = harness({ chats: [], beforeAppend: () => ctx.h!.host.suspend() })
    ctx.h = h
    h.host.setFullWake(false)
    h.setNow(NIGHT + 11 * 60 * 60_000)
    expect(await h.tidyNow()).toEqual({ started: true })
    expect(h.runs()).toHaveLength(1)
    expect(h.delivered).toHaveLength(1)
  })

  it("leaves a run this process started alone when its first tick closes a restart's cut-off runs", async () => {
    const end = Promise.withResolvers<BotTurnEnd>()
    const h = harness({ chats: [], turnEnd: () => end.promise })
    h.setNow(NIGHT + 11 * 60 * 60_000)
    expect(h.runner.tidyNow('b1')).toEqual({ started: true })
    await vi.waitFor(() => expect(h.startConversation).toHaveBeenCalledTimes(1))
    // The scheduler's first tick in this process comes while Tidy now is still running.
    await h.runner.tick()
    expect(h.runs()[0]?.endedAt).toBeUndefined()
    end.resolve({ outcome: 'success', message: reply(INDEX, REPLACED) })
    await vi.waitFor(() => expect(h.runs()[0]?.endedAt).toBeDefined())
    expect(h.runs()[0]?.error).toBeUndefined()
  })
})

describe('Tidy-up on ops, for a bot in the pilot', () => {
  const STATUS = '- 2026-11-02 #4417 merged at a1b2c3d4; follow-up waiting on review'
  const OLD = [
    '# Memory',
    '- 2026-10-02 times in Eastern',
    '- 2026-10-03 times are in Eastern',
    STATUS,
    '- 2026-10-06 PRs open ready, not draft',
    ''
  ].join('\n')
  const SHOWN = OLD.replace(`${STATUS}\n`, '')
  const merge = (): string => {
    const [first, second] = memorySnapshot(SHOWN)
    return `Done.\n[{"op":"merge","lines":["${first.ref}","${second.ref}"],"text":"all times are in Eastern"}]`
  }
  const JOURNAL = join(HOME, 'memory', 'journal', '2026-11.md')
  const TIDIED =
    '# Memory\n- 2026-10-02 all times are in Eastern\n- 2026-10-06 PRs open ready, not draft\n'

  it('moves status to the journal and applies the ops as one History row', async () => {
    const run = harness({ memory: OLD, reply: merge() })
    run.files.set(join(HOME, TIDY_UP_OPS_PILOT_FILE), '')
    await run.tick()

    const shownRef = `${memorySnapshot(SHOWN)[0].ref} - 2026-10-02 times in Eastern`
    expect(run.startConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ text: expect.stringContaining(shownRef) })
    )
    expect(run.startConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ text: expect.not.stringContaining('#4417') })
    )
    expect(run.files.get(MEMORY)).toBe(TIDIED)
    expect(run.files.get(JOURNAL)).toBe(`# Status moved out of MEMORY.md, 2026-11\n${STATUS}\n`)
    expect(run.files.get(ARCHIVE)).toBe(
      '# Archive\n- 2026-10-02 times in Eastern · merged 2026-11-06\n- 2026-10-03 times are in Eastern · merged 2026-11-06\n'
    )
    expect(await run.rows()).toHaveLength(1)
    expect(run.last()).toMatchObject({
      filed: [{ topic: 'journal/2026-11', count: 1 }],
      merged: 1,
      moved: 0,
      skipped: []
    })
  })

  it('stays on the whole-file reply off the pilot', async () => {
    const run = harness({ memory: OLD, reply: merge() })
    await run.tick()
    expect(run.files.get(MEMORY)).toBe(OLD)
    expect(run.runs()[0].error).toBe(TIDY_UP_FAILURES.noDraft)
  })

  it("keeps a stale chat's rewrite from putting moved lines back, unless its owner asked", async () => {
    const run = harness({ memory: OLD, reply: merge() })
    run.files.set(join(HOME, TIDY_UP_OPS_PILOT_FILE), '')
    await run.tick()
    const owner = (text: string): AgentJournalRenderItem => ({
      itemId: 'i1',
      revision: 1,
      sequence: 1,
      observedAt: run.now(),
      turnScope: { kind: 'turn', turnItemId: 't1' },
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
    })
    // The chat read OLD at its start and writes it back whole, with one new line of its own.
    const rewrite = async (turn: AgentJournalRenderItem[]) => {
      run.files.set(MEMORY, `${OLD}- 2026-11-06 Lesson: check worker liveness after a restart\n`)
      const record = { history: async () => run.rows() }
      const keepOut = await readdGuard(
        run.fs,
        { botId: 'b1', folder: HOME },
        record,
        turn,
        run.now()
      )
      return tagBotMemoryFile(run.fs, HOME, TIDIED, async () => null, keepOut)
    }

    const tagged = await rewrite([owner('Thanks, carry on')])
    expect(tagged?.text).toBe(
      `${TIDIED}- 2026-11-06 Lesson: check worker liveness after a restart\n`
    )
    expect(run.files.get(ARCHIVE)).toContain(`${STATUS} · kept out 2026-11-06`)
    expect(run.files.get(ARCHIVE)).toContain('- 2026-10-02 times in Eastern · kept out 2026-11-06')

    const asked = await rewrite([owner('Put the #4417 merged at a1b2c3d4 follow-up line back')])
    expect(asked?.text).toContain(STATUS)
  })

  it('keeps nothing out before the record knows the file, or when the archive cannot take it', async () => {
    const run = harness({ memory: OLD, reply: merge() })
    run.files.set(join(HOME, TIDY_UP_OPS_PILOT_FILE), '')
    await run.tick()
    const record = { history: async () => run.rows() }
    const keepOut = await readdGuard(run.fs, { botId: 'b1', folder: HOME }, record, [], run.now())
    run.files.set(MEMORY, OLD)
    const unknown = await tagBotMemoryFile(run.fs, HOME, '', async () => null, keepOut)
    expect(unknown?.text).toContain(STATUS)

    run.files.set(MEMORY, OLD)
    const archive = run.files.get(ARCHIVE) ?? ''
    const replace = run.fs.replaceText
    run.fs.replaceText = async (path, expected, text) =>
      path !== ARCHIVE && replace(path, expected, text)
    const refused = await tagBotMemoryFile(run.fs, HOME, TIDIED, async () => null, keepOut)
    expect(refused?.text).toContain(STATUS)
    expect(run.files.get(ARCHIVE)).toBe(archive)
  })

  it('keeps the status move but fails the ops half when the reply is unreadable', async () => {
    const run = harness({ memory: OLD, reply: 'Sorry, I could not do that.' })
    run.files.set(join(HOME, TIDY_UP_OPS_PILOT_FILE), '')
    await run.tick()
    expect(run.files.get(MEMORY)).toBe(SHOWN)
    expect(run.files.get(JOURNAL)).toContain(STATUS)
    expect(run.runs()[0].error).toBe(TIDY_UP_FAILURES.noOps)
    expect(run.through()).toBeUndefined()
    expect(run.last()).toMatchObject({ filed: [{ topic: 'journal/2026-11', count: 1 }] })
  })

  it('fails a run whose every op was skipped, so its chats are read again', async () => {
    const run = harness({
      memory: SHOWN,
      reply: '[{"op":"retire","line":"L9#0000","reason":"stale"}]'
    })
    run.files.set(join(HOME, TIDY_UP_OPS_PILOT_FILE), '')
    await run.tick()
    expect(run.files.get(MEMORY)).toBe(SHOWN)
    expect(run.runs()[0].error).toBe(
      `${TIDY_UP_FAILURES.allSkipped} (retire 1: names a line MEMORY.md no longer has)`
    )
    expect(run.through()).toBeUndefined()
  })
})
