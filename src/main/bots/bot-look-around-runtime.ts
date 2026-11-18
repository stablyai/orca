// The runtime's one Look around runner, shared by the scheduler tick, Look now and a bot's onboarding.
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { AutomationService } from '../automations/automation-service'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { botTurns, runtimeBotAutomationSessions } from './bot-automation-sessions'
import { systemBackgroundRunPower } from './bot-background-run-power'
import { requireStructuredHost } from './bot-chat-session'
import { noteInChat } from './bot-chat-status-line'
import {
  limitedLookContinuesInItsChat,
  LOOK_FAILURES_TO_TURN_OFF
} from './bot-look-around-failures'
import { BotLookAroundRunner } from './bot-look-around-runner'
import { watchContinuedLooks } from './bot-look-around-continued'
import { runtimeTidyUpRunner } from './bot-memory-tidy-up-runtime'

const LOOK_TURNED_OFF = `Look around turned off: the last ${LOOK_FAILURES_TO_TURN_OFF} looks failed. Turn it back on in Settings.`
import { watchBotTurnEnds } from './bot-run-turn-watch'

const runners = new WeakMap<object, BotLookAroundRunner>()

export function runtimeLookAroundRunner(runtime: OrcaRuntimeService): BotLookAroundRunner {
  const existing = runners.get(runtime)
  if (existing) {
    return existing
  }
  const runner = new BotLookAroundRunner({
    bots: () => (runtime.bots.enabled() ? runtime.bots.list() : []),
    store: runtime.lookAround,
    hadConversation: async (bot) =>
      (await runtime.listChatSessionTabs(folderWorkspaceKey(bot.folderWorkspaceId))).length > 0,
    sessions: runtimeBotAutomationSessions(runtime),
    stopTurn: botTurns.stop,
    turnRunning: botTurns.running,
    usageLimitOf: async (sessionId) => {
      const host = await requireStructuredHost(runtime)
      const cut = await (await host.journalReads(sessionId)).usageLimitCut()
      return cut ? (cut.resetsAt === undefined ? {} : { resetsAt: cut.resetsAt }) : null
    },
    usageLimitContinues: async (sessionId) => {
      const host = await requireStructuredHost(runtime)
      const cut = await (await host.journalReads(sessionId)).usageLimitCut()
      return limitedLookContinuesInItsChat({
        running: botTurns.running(sessionId),
        stillLimited: cut !== null,
        continueScheduled:
          !!cut && host.usageLimitContinue.readState(sessionId, cut)?.state === 'scheduled'
      })
    },
    watchTurns: async () => watchBotTurnEnds(await requireStructuredHost(runtime)),
    turnOff: async (bot) => {
      await runtime.bots.update(bot.id, { lookAround: { on: false } })
      noteInChat(bot.chatSessionId ?? undefined, LOOK_TURNED_OFF)
    },
    power: systemBackgroundRunPower(),
    now: Date.now
  })
  runners.set(runtime, runner)
  // A look its usage limit stopped finishes in the turn that continues it, whoever sends it.
  void requireStructuredHost(runtime)
    .then((host) => watchContinuedLooks(host, runtime.lookAround, Date.now))
    .catch((error: unknown) => console.warn('[bots] could not watch continued looks', error))
  return runner
}

/** Looks and tidy-ups ride the host's automation scheduler: its minute tick, while it runs. */
export function bindLookAroundToAutomations(
  service: Pick<AutomationService, 'onTick'>,
  runtime: OrcaRuntimeService
): void {
  // Deferred so a failure here, even building a runner, never stops the scheduler's own tick.
  service.onTick = () => {
    void Promise.resolve()
      .then(() => runtimeLookAroundRunner(runtime).tick())
      .catch((error: unknown) => console.warn('[bots] look-around tick failed', error))
    void Promise.resolve()
      .then(() => runtimeTidyUpRunner(runtime).tick())
      .catch((error: unknown) => console.warn('[bots] tidy-up tick failed', error))
  }
}
