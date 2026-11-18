// Starts each bot's nightly Tidy-up, after Look around's runner: a tool-free conversation in the
// bot's home whose reply is a draft, which Orca checks and writes through the memory record, so the
// run is one History row whose Undo puts MEMORY.md back. Files in memory/ are written first.
import { OWNER_ACTS_FOR } from '../../shared/bots/bot-acts-for'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { botMemoryDate } from '../../shared/bot-memory-lines'
import type { Bot } from '../../shared/bot-types'
import {
  type BotTidyUpNote,
  botTidyUp,
  tidyUpChangeCount,
  type TidyNowRefusal
} from '../../shared/bots/bot-tidy-up'
import { lookAroundSupported } from '../../shared/bots/bot-look-around'
import type { BotAutomationSessions } from '../automations/bot-automation-launch'
import {
  type BackgroundRunPower,
  type BackgroundRunWatch,
  awaitRunEnd,
  stopIfKept,
  runGate,
  type RunStart,
  startWithinLimit,
  turnFailed,
  watchBackgroundRun
} from './bot-background-run'
import type { BotHomeFilesystem } from './bot-home'
import {
  failedLooksInARow,
  LOOK_FAILURES_TO_TURN_OFF,
  lookFailureIsQuiet
} from './bot-look-around-failures'
import type { BotLookAroundStore } from './bot-look-around-store'
import { withoutBackgroundRun } from './bot-look-around-state'
import type { BotMemoryRecord } from './bot-memory-record'
import {
  beginTidyUp,
  type BotTidyUpState,
  endTidyUp,
  TIDY_UP_FAILURES,
  TIDY_UP_FIRST_LOOKBACK_MS,
  TIDY_UP_RUN_LIMIT_MS,
  type TidyUpChat,
  type TidyUpMemoryFile,
  tidyUpOwed,
  tidyUpPrompt,
  tidyUpRunSummary,
  type TidyUpApplied,
  tidyNowRefusal,
  tidyUpState
} from './bot-memory-tidy-up'
import { applyTidyUpDraft } from './bot-memory-tidy-up-apply'
import type { BotTurnWatch } from './bot-run-turn-watch'

export type BotTidyUpRunnerDeps = {
  bots: () => readonly Bot[]
  store: Pick<BotLookAroundStore, 'get' | 'update'>
  /** The bot's chats with lines from its owner since `since`, newest first and only as many as the
   *  prompt reads; never its looks or tidy-ups. */
  newChats: (bot: Bot, since: number) => Promise<TidyUpChat[]>
  /** Whether any of the bot's conversations is running a turn. */
  busy: (bot: Bot) => boolean
  memory: Pick<BotMemoryRecord, 'change' | 'history'>
  fs: Pick<BotHomeFilesystem, 'readText' | 'writeText' | 'replaceText' | 'makeDirectory'>
  /** The files in the bot's memory/ folder, the archive among them, as far as the prompt reads. */
  memoryFiles: (folder: string) => Promise<TidyUpMemoryFile[]>
  homeFolder: (bot: Bot) => string
  sessions: Pick<BotAutomationSessions, 'startConversation' | 'release'>
  watchTurns: () => Promise<BotTurnWatch>
  stopTurn: (sessionId: string) => Promise<void>
  turnRunning: (sessionId: string) => boolean
  /** A line in the bot's Home Chat: this tidy-up changed something. */
  noteTidied: (bot: Bot, note: BotTidyUpNote) => void
  /** Turns the bot's Tidy-up off after too many failed runs in a row, saying why. */
  turnOff: (bot: Bot, lastError: string) => Promise<void>
  power: BackgroundRunPower
  now: () => number
}

type Failed = { error: string; alerted: boolean; asleep?: boolean }
type Ended = Failed | { through: number }
const TIDY_UP_ASLEEP: Failed = { error: TIDY_UP_FAILURES.asleep, alerted: false, asleep: true }

export class BotTidyUpRunner {
  /** Bots with a tidy-up running in this process. */
  private readonly running = new Set<string>()
  /** Runs this process started; only a recorded run outside it was cut off by a restart. */
  private readonly ownSessions = new Set<string>()
  private ticking = false
  private checkedAbandoned = false

  constructor(private readonly deps: BotTidyUpRunnerDeps) {}

  /** `next` returns null to leave the state as it is. */
  private change(botId: string, next: (state: BotTidyUpState) => BotTidyUpState | null): void {
    this.deps.store.update(botId, (state) => {
      const tidyUp = next(tidyUpState(state))
      return { state: tidyUp ? { ...state, tidyUp } : state, result: null }
    })
  }

  /** None of the bot's conversations is running a turn, and it may tidy at all. */
  private idle(bot: Bot): boolean {
    return !bot.paused && lookAroundSupported(bot.agent) && !this.deps.busy(bot)
  }

  /** Settings' and the phone's Tidy now: a run now, on whatever chats are new, even none. */
  tidyNow(botId: string): { started: true } | { refused: TidyNowRefusal } {
    const bot = this.deps.bots().find((entry) => entry.id === botId)
    const refusal = tidyNowRefusal(bot, {
      running: bot ? this.running.has(bot.id) : false,
      busy: bot ? this.deps.busy(bot) : false
    })
    if (!bot || refusal) {
      return { refused: refusal ?? 'not_found' }
    }
    void this.run(bot, 'now')
    return { started: true }
  }

  /** Called on the automation scheduler's tick. */
  async tick(): Promise<void> {
    if (this.ticking) {
      return
    }
    this.ticking = true
    try {
      const now = this.deps.now()
      const bots = this.deps.bots()
      this.closeAbandoned(bots, now)
      // Never in a dark wake, where the host sleeps again within seconds. Read every tick while
      // a bot tidies, so the awake clock keeps sampling and sees a sleep without power events.
      const settled = bots.some((bot) => botTidyUp(bot).on) && this.deps.power.settled()
      const due = () => bots.filter((bot) => this.scheduledMayStart(bot, now))
      // Read only when a run is due: on a Mac it asks the system whether this is a full wake.
      if (settled && due().length > 0 && (await this.deps.power.checkFullWake())) {
        due().forEach((bot) => void this.run(bot, 'scheduled'))
      }
    } finally {
      this.ticking = false
    }
  }

  private scheduledMayStart(bot: Bot, now: number, sessionId?: string): boolean {
    const state = tidyUpState(this.deps.store.get(bot.id))
    // A run being admitted is in the state already; its own slot is judged without it.
    const before = sessionId ? withoutBackgroundRun(state, sessionId) : state
    return (
      (sessionId !== undefined || !this.running.has(bot.id)) &&
      tidyUpOwed(bot, before, now) &&
      this.idle(bot)
    )
  }

  /** A run recorded without an end that this process never started was cut off by a restart. */
  private closeAbandoned(bots: readonly Bot[], now: number): void {
    if (this.checkedAbandoned) {
      return
    }
    this.checkedAbandoned = true
    const cutOff = { error: TIDY_UP_FAILURES.unfinished, alerted: false }
    for (const bot of bots) {
      for (const run of tidyUpState(this.deps.store.get(bot.id)).runs) {
        if (run.endedAt === undefined && !this.ownSessions.has(run.sessionId)) {
          this.change(bot.id, (state) => endTidyUp(state, run.sessionId, now, cutOff))
        }
      }
    }
  }

  /** One run of the bot's at a time: the bot is held from here, before anything is awaited, until
   *  the run ends, so a scheduled run and Tidy now can't both start. */
  private async run(bot: Bot, by: 'scheduled' | 'now'): Promise<void> {
    this.running.add(bot.id)
    const sessionId = randomUUID()
    this.ownSessions.add(sessionId)
    const folder = this.deps.homeFolder(bot)
    let watch: BackgroundRunWatch | null = null
    let ended: Ended = { error: TIDY_UP_FAILURES.couldNotStart, alerted: false }
    let begun = false
    let before: BotTidyUpState | undefined
    let start: RunStart | undefined
    const gate = runGate(this.deps.power, {
      scheduled: by === 'scheduled',
      // At its opening message and delivery, the bot as it is now still owes the run.
      mayStart: () =>
        this.deps
          .bots()
          .some(
            (now) => now.id === bot.id && this.scheduledMayStart(now, this.deps.now(), sessionId)
          )
    })
    let applied: TidyUpApplied | null = null
    let startedAt = this.deps.now()
    let chatCount = 0
    try {
      const since = tidyUpState(this.deps.store.get(bot.id)).through
      const chats = await this.deps
        .newChats(bot, since ?? startedAt - TIDY_UP_FIRST_LOOKBACK_MS)
        .catch((error: unknown) => {
          console.warn('[bots] tidy-up could not read its chats', error)
          return null
        })
      // Unread chats are never skipped: the watermark stays, and a scheduled run tries again on a
      // later tick. Tidy now says why it stopped.
      if (chats === null) {
        if (by === 'now') {
          this.change(bot.id, (state) => beginTidyUp(state, sessionId, startedAt))
          begun = true
          ended = { error: TIDY_UP_FAILURES.unreadChats, alerted: false }
        }
        return
      }
      if (chats.length === 0 && by === 'scheduled') {
        this.change(bot.id, (state) => ({ ...state, checkedAt: startedAt }))
        return
      }
      chatCount = chats.length
      const memory = (await this.deps.fs.readText(join(folder, 'MEMORY.md'))) ?? ''
      const files = await this.deps.memoryFiles(folder)
      // Checked again after reading, as near the start as it can be: an owner turn may have begun.
      if (!this.idle(bot)) {
        return
      }
      startedAt = this.deps.now()
      const today = botMemoryDate(new Date(startedAt))
      // Recorded before the session exists, so its launch already knows it gets no tools.
      this.change(bot.id, (state) => beginTidyUp((before = state), sessionId, startedAt))
      begun = true
      // The ten minutes run from here, through the reply; the apply after is local and is never
      // cut off midway, though a sleep in it still makes the run missed.
      watch = watchBackgroundRun(this.deps.power, sessionId)
      const text = tidyUpPrompt({ memory, files, chats, today })
      start = startWithinLimit(
        watch,
        {
          setup: () => this.deps.watchTurns(),
          start: async () => {
            await gate.beforeFirstMessage()
            const send = await this.deps.sessions.startConversation(bot, {
              sessionId,
              text,
              beforeFirstMessage: gate.beforeFirstMessage,
              beforeDelivery: gate.beforeDelivery,
              title: 'Tidy-up',
              actsFor: { actsFor: [...OWNER_ACTS_FOR] }
            })
            gate.afterStart()
            return send
          },
          stopTurn: () => this.deps.stopTurn(sessionId)
        },
        TIDY_UP_RUN_LIMIT_MS
      )
      gate.attach(start)
      const reply = await this.reply(watch, sessionId, start)
      const outcome =
        'error' in reply
          ? reply
          : await applyTidyUpDraft(this.deps, {
              botId: bot.id,
              folder,
              memory,
              reply: reply.text,
              today
            })
      if ('error' in outcome) {
        ended = outcome
      } else {
        applied = outcome
        ended = { through: startedAt }
      }
    } catch (error) {
      if (!gate.deferred()) {
        console.warn('[bots] tidy-up could not run', error)
      }
      await stopIfKept(gate, this.deps, sessionId, start)
    } finally {
      gate.finish()
      start?.dispose()
      const deferred = gate.deferred()
      // Slept during a run that then failed, however it failed: missed, its chats kept to retry.
      ended = !deferred && 'error' in ended && watch?.slept() ? TIDY_UP_ASLEEP : ended
      watch?.end()
      if (deferred) {
        this.change(bot.id, (state) => withoutBackgroundRun(state, sessionId, before))
        void this.deps.sessions.release(sessionId)
      } else if (begun) {
        const at = { startedAt, chats: chatCount, now: this.deps.now() }
        const summary = applied && tidyUpRunSummary(this.deps.memory.history(bot.id), applied, at)
        this.change(bot.id, (state) => {
          const quiet = 'error' in ended && ended.alerted && lookFailureIsQuiet(state, sessionId)
          const next = endTidyUp(
            state,
            sessionId,
            this.deps.now(),
            quiet ? { ...ended, alerted: false } : ended
          )
          return summary ? { ...next, last: summary } : next
        })
        if (summary) {
          this.deps.noteTidied(bot, { botId: bot.id, changes: tidyUpChangeCount(summary) })
        }
        void this.deps.sessions.release(sessionId)
      }
      this.running.delete(bot.id)
      this.ownSessions.delete(sessionId)
    }
    const state = tidyUpState(this.deps.store.get(bot.id))
    if (
      !gate.deferred() &&
      'error' in ended &&
      failedLooksInARow(state) >= LOOK_FAILURES_TO_TURN_OFF
    ) {
      await this.deps.turnOff(bot, ended.error).catch((error: unknown) => {
        console.warn('[bots] could not turn off a failing Tidy-up', error)
      })
    }
  }

  /** The run's last message, or why there is none. */
  private async reply(
    watch: BackgroundRunWatch,
    sessionId: string,
    start: RunStart
  ): Promise<{ text: string } | Failed> {
    const ended = await awaitRunEnd(watch, this.deps, sessionId, start)
    if (ended !== 'timed_out' && 'outcome' in ended && ended.outcome === 'success') {
      return { text: ended.message }
    }
    return ended === 'timed_out'
      ? { error: TIDY_UP_FAILURES.timedOut, alerted: false }
      : { error: TIDY_UP_FAILURES.unfinished, alerted: turnFailed(ended) }
  }
}
