// Starts each bot's looks: on its Look around hours, and on Look now (Settings, or a bot's onboarding).
// A look is a new conversation in the bot's home whose session the store records before it starts,
// which is how its launch, its tool calls and Orca's own commands know it may only read.
import { OWNER_ACTS_FOR } from '../../shared/bots/bot-acts-for'
import { randomUUID } from 'node:crypto'
import type { Bot } from '../../shared/bot-types'
import { botLookAround, lookAroundSupported } from '../../shared/bots/bot-look-around'
import type { BotAutomationSessions } from '../automations/bot-automation-launch'
import type { BotTurnWatch } from './bot-run-turn-watch'
import type { LookUsageLimit } from './bot-background-run-history'
import type { BotLookAroundStore } from './bot-look-around-store'
import {
  beginRun,
  endRun,
  lookHistory,
  withMissedSlot,
  withoutBackgroundRun,
  type BotLookState,
  type LookSlot
} from './bot-look-around-state'
import {
  failedLooksInARow,
  LOOK_FAILURES_TO_TURN_OFF,
  lookFailureIsQuiet,
  usageLimitAlreadyNoted
} from './bot-look-around-failures'
import { HeldLookSlots } from './bot-look-around-held'
import { lookAroundPrompt } from './bot-look-around-prompt'
import { LOOK_FAILURES, LOOK_RUN_LIMIT_MS, lookFailureOf } from './bot-look-around-run-outcome'
import { lookAroundDecision, lookAroundDueAt } from './bot-look-around-schedule'
import {
  BACKGROUND_RUN_STOP_GRACE_MS,
  type BackgroundRunPower,
  awaitRunEnd,
  stopIfKept,
  runGate,
  type RunStart,
  startWithinLimit,
  turnFailed,
  watchBackgroundRun
} from './bot-background-run'

/** How long a stopped look's turn gets to end before its Stop is asked again. */
export const LOOK_STOP_GRACE_MS = BACKGROUND_RUN_STOP_GRACE_MS

export type LookNowRefusal = 'not_found' | 'unsupported' | 'off' | 'paused' | 'running'
export type LookNowOutcome = { started: true } | { refused: LookNowRefusal }

export type BotLookAroundRunnerDeps = {
  bots: () => readonly Bot[]
  store: Pick<BotLookAroundStore, 'get' | 'update'>
  /** Whether the bot has had a conversation; its looks start one interval after it first has. */
  hadConversation: (bot: Bot) => Promise<boolean>
  sessions: Pick<BotAutomationSessions, 'startConversation' | 'sendToChat' | 'release'>
  watchTurns: () => Promise<BotTurnWatch>
  /** Asks the session's host to stop its turn. */
  stopTurn: (sessionId: string) => Promise<void>
  /** Whether the session's host still runs its turn or holds a question in it. */
  turnRunning: (sessionId: string) => boolean
  /** The usage limit that ended the session's last turn, or null when none did. */
  usageLimitOf: (sessionId: string) => Promise<LookUsageLimit | null>
  /** Whether a usage-limited look finishes in its own chat (see `limitedLookContinuesInItsChat`),
   *  so its slot starts no other. */
  usageLimitContinues: (sessionId: string) => Promise<boolean>
  /** Turns the bot's Look around off, after too many failed looks in a row. */
  turnOff: (bot: Bot) => Promise<void>
  power: BackgroundRunPower
  now: () => number
}

export class BotLookAroundRunner {
  /** Bots with a look running in this process. */
  private readonly running = new Set<string>()
  private ticking = false
  private checkedAbandoned = false
  private readonly held = new HeldLookSlots()
  /** Looks this process started; only a recorded run outside it was cut off by a restart. */
  private readonly ownSessions = new Set<string>()

  constructor(private readonly deps: BotLookAroundRunnerDeps) {}

  private change(botId: string, next: (state: BotLookState) => BotLookState): void {
    this.deps.store.update(botId, (state) => ({ state: next(state), result: null }))
  }

  /** A receipt only for a bot unchanged since the slot, seen by an awake host: one paused, turned
   *  off or edited since may simply not have been due then. */
  private noteMissed(bot: Bot, state: BotLookState, missedAt: number, settled: boolean): void {
    if (
      !settled ||
      bot.updatedAt > missedAt ||
      state.missedSlots?.includes(missedAt) ||
      !this.deps
        .bots()
        .some(
          (current) =>
            current.id === bot.id &&
            !current.paused &&
            botLookAround(current).on &&
            current.updatedAt === bot.updatedAt
        )
    ) {
      return
    }
    this.change(bot.id, (current) => withMissedSlot(current, missedAt))
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
      // Read every tick while a bot looks around, so the awake clock keeps sampling and sees a
      // sleep even on a host with no power events.
      const settled = bots.some((bot) => botLookAround(bot).on) && this.deps.power.settled()
      const due: { bot: Bot; slot: number }[] = []
      for (const bot of bots) {
        const setting = botLookAround(bot)
        if (
          !setting.on ||
          bot.paused ||
          !lookAroundSupported(bot.agent) ||
          this.running.has(bot.id)
        ) {
          continue
        }
        const state = this.deps.store.get(bot.id)
        if (state.armedAt === undefined) {
          if (await this.deps.hadConversation(bot).catch(() => false)) {
            this.change(bot.id, (current) => ({ ...current, armedAt: current.armedAt ?? now }))
          }
          continue
        }
        const { due: slot, missedAt } = lookAroundDecision(setting, state, now)
        if (missedAt !== undefined) {
          this.noteMissed(bot, state, missedAt, settled)
        }
        const limited = state.runs.findLast((run) => run.endedAt !== undefined)
        // Only the slot the limited look took finishes in its chat; later slots are their own.
        if (
          slot !== null &&
          !(
            limited?.usageLimited &&
            limited.startedAt >= slot &&
            (await this.deps.usageLimitContinues(limited.sessionId).catch(() => false))
          )
        ) {
          due.push({ bot, slot })
        }
      }
      // Never in a dark wake, where the host sleeps again within seconds and the look is cut off.
      // On a Mac the full-wake check asks the system, so it runs only when a look is due.
      if (due.length === 0) {
        return
      }
      if (settled && (await this.deps.power.checkFullWake())) {
        for (const { bot, slot } of due) {
          if (!this.running.has(bot.id)) {
            const late = this.held.isLate(bot, slot)
            void this.run(bot, { scheduledFor: slot, ...(late ? { late: true } : {}) })
          }
        }
      } else {
        // Remembered, so the look reads as late once it starts.
        for (const { bot, slot } of due) {
          this.held.note(bot, slot)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  /** Starts a look now, as Settings' Look now and a new bot's onboarding do. */
  lookNow(botId: string): LookNowOutcome {
    const bot = this.deps.bots().find((entry) => entry.id === botId)
    const refusal: LookNowRefusal | null = !bot
      ? 'not_found'
      : !lookAroundSupported(bot.agent)
        ? 'unsupported'
        : !botLookAround(bot).on
          ? 'off'
          : bot.paused
            ? 'paused'
            : this.running.has(bot.id)
              ? 'running'
              : null
    if (!bot || refusal) {
      return { refused: refusal ?? 'not_found' }
    }
    const now = this.deps.now()
    // Asking for a look is a conversation of its own, so it arms the schedule too.
    this.change(bot.id, (state) => ({ ...state, armedAt: state.armedAt ?? now }))
    void this.run(bot)
    return { started: true }
  }

  private closeAbandoned(bots: readonly Bot[], now: number): void {
    if (this.checkedAbandoned) {
      return
    }
    this.checkedAbandoned = true
    for (const bot of bots) {
      for (const run of this.deps.store.get(bot.id).runs) {
        if (run.endedAt === undefined && !this.ownSessions.has(run.sessionId)) {
          this.change(bot.id, (state) =>
            endRun(state, run.sessionId, now, LOOK_FAILURES.interrupted)
          )
        }
      }
    }
  }

  /** The bot as it is now still has this slot due: on, not paused, able to look, and owed the
   *  slot, judged without the look being admitted. */
  private mayStart(botId: string, sessionId: string, slot: number): boolean {
    const bot = this.deps.bots().find((entry) => entry.id === botId)
    if (!bot || !botLookAround(bot).on || bot.paused || !lookAroundSupported(bot.agent)) {
      return false
    }
    const state = withoutBackgroundRun(this.deps.store.get(botId), sessionId)
    return lookAroundDueAt(botLookAround(bot), state, this.deps.now()) === slot
  }

  /** `slot` is the scheduled slot it takes; Look now has none and is never held back. */
  private async run(bot: Bot, slot?: LookSlot): Promise<void> {
    this.running.add(bot.id)
    const sessionId = randomUUID()
    this.ownSessions.add(sessionId)
    const startedAt = this.deps.now()
    const text = lookAroundPrompt({
      focus: botLookAround(bot).focus,
      history: lookHistory(this.deps.store.get(bot.id), startedAt)
    })
    if (slot) {
      this.held.clear(bot.id)
    }
    // Recorded before the session exists, so its launch already knows it only reads.
    let before: BotLookState | undefined
    this.change(bot.id, (state) => beginRun((before = state), sessionId, startedAt, slot))
    const watch = watchBackgroundRun(this.deps.power, sessionId)
    let failure: string | undefined
    let notifies = false
    let usageLimited: LookUsageLimit | undefined
    const gate = runGate(this.deps.power, {
      scheduled: slot !== undefined,
      mayStart: () => slot !== undefined && this.mayStart(bot.id, sessionId, slot.scheduledFor)
    })
    let start: RunStart | undefined
    try {
      // The ten minutes run from here, where the look is recorded and the host held awake.
      start = startWithinLimit(
        watch,
        {
          setup: () => this.deps.watchTurns(),
          start: async () => {
            await gate.beforeFirstMessage()
            const send = await this.deps.sessions.startConversation(bot, {
              text,
              title: 'Look around',
              sessionId,
              beforeFirstMessage: gate.beforeFirstMessage,
              beforeDelivery: gate.beforeDelivery,
              actsFor: { actsFor: [...OWNER_ACTS_FOR] }
            })
            gate.afterStart()
            return send
          },
          stopTurn: () => this.deps.stopTurn(sessionId)
        },
        LOOK_RUN_LIMIT_MS
      )
      gate.attach(start)
      const ended = await awaitRunEnd(watch, this.deps, sessionId, start)
      failure = lookFailureOf(ended)
      notifies = turnFailed(ended)
      if (notifies) {
        usageLimited = (await this.deps.usageLimitOf(sessionId).catch(() => null)) ?? undefined
      }
    } catch (error) {
      if (!gate.deferred()) {
        console.warn('[bots] look-around could not run', error)
        failure = LOOK_FAILURES.couldNotStart
      }
      await stopIfKept(gate, this.deps, sessionId, start)
    } finally {
      gate.finish()
      start?.dispose()
      // Sleep is tracked through the stop at the limit, up to here.
      const asleep = failure !== undefined && watch.slept()
      const deferred = gate.deferred()
      watch.end()
      if (asleep) {
        failure = LOOK_FAILURES.asleep
        notifies = false
      }
      this.change(bot.id, (state) =>
        deferred
          ? withoutBackgroundRun(state, sessionId, before)
          : endRun(
              state,
              sessionId,
              this.deps.now(),
              failure,
              notifies &&
                !lookFailureIsQuiet(state, sessionId) &&
                !(usageLimited && usageLimitAlreadyNoted(state.runs)),
              asleep,
              usageLimited
            )
      )
      // Taken back at its opening message, its slot still due: the host's power held it.
      if (deferred && slot && this.mayStart(bot.id, sessionId, slot.scheduledFor)) {
        this.held.note(bot, slot.scheduledFor)
      }
      this.running.delete(bot.id)
      this.ownSessions.delete(sessionId)
      void this.deps.sessions.release(sessionId)
    }
    if (
      failure &&
      !gate.deferred() &&
      failedLooksInARow(this.deps.store.get(bot.id)) >= LOOK_FAILURES_TO_TURN_OFF
    ) {
      await this.deps.turnOff(bot).catch((error: unknown) => {
        console.warn('[bots] could not turn off a failing Look around', error)
      })
    }
  }
}
