// Execution helpers and shared contracts for bot usage-limit failover and return-to-primary.
import { randomUUID } from 'node:crypto'
import type { Bot, BotAgent } from '../../shared/bot-types'
import {
  backupEntryToLaunch,
  botModelTargetKey,
  botPrimaryTarget,
  effectiveBotSetup,
  sameBotModelTarget,
  type BotActiveBackup,
  type BotBackupModelEntry
} from '../../shared/bots/bot-backup-models'
import type { AgentJournalBotBackupModelSwitchItem } from '../../shared/agent-journal-orca-card-items'
import type { HostUsageLimitCut } from '../native-chat/agent-session-wire/recovery/structured-agent-session-usage-limit-chain'
import {
  executeCrossAgentBotHandoff,
  type BotCrossAgentHandoffDeps
} from './bot-cross-agent-handoff'
import type { BotUsageLimitGate, BotUsageLimitKey } from './bot-usage-limit-gate'

export type BotCutBackupState = {
  turnItemId: string
  backupState: 'switching' | 'ask-backup' | 'backups-exhausted'
  backupResetsAt?: number
}

export type BotFailoverSessionInfo = {
  sessionId: string
  provider: BotAgent
  model?: string
  isIdle: boolean
  runtimeFence: number
}

export type BotUsageLimitFailoverDeps = {
  gate: BotUsageLimitGate
  now?: () => number
  listBots: () => readonly Bot[]
  botOfSession: (sessionId: string) => Bot | null
  updateBot: (
    botId: string,
    edit: (bot: Bot) => {
      backupModels?: Bot['backupModels'] | null
      activeBackup?: BotActiveBackup | null
    }
  ) => Promise<Bot>
  getSessionInfo: (sessionId: string) => Promise<BotFailoverSessionInfo | null>
  /** Host-internal canonical account home key for `(agent, sessionId?)`; never exposed to clients. */
  resolveAccountHomeKey: (agent: BotAgent, sessionId?: string) => Promise<string>
  /** Installed, chat-capable agents currently available on this host. */
  availableAgents: () => Promise<ReadonlySet<BotAgent>>
  /** Applies model and optional execution options in-place on an existing same-agent session. */
  applySameAgentOptions: (sessionId: string, target: BotBackupModelEntry) => Promise<boolean>
  /** Sends the continuation turn on a same-agent session after switching models. */
  sendSameAgentContinuation: (
    sessionId: string,
    cut: Pick<HostUsageLimitCut, 'turnItemId' | 'resetsAt'>,
    runtimeFence: number
  ) => Promise<boolean>
  appendSwitchCard: (
    sessionId: string,
    item: AgentJournalBotBackupModelSwitchItem,
    at: number
  ) => Promise<void>
  /** Notifies status subscribers for `sessionId` when cut backup state changes. */
  publishSessionStatus: (sessionId: string) => void
  /** Lists active session ids for `botId` so config edits can re-evaluate held cuts. */
  listBotSessionIds?: (botId: string) => readonly string[]
  /** Reads the latest usage-limit cut for a session if still sitting at one. */
  readSessionCut?: (sessionId: string) => Promise<HostUsageLimitCut | null>
  crossAgentHandoff: BotCrossAgentHandoffDeps
}

export async function pickReadyBotBackup(
  deps: BotUsageLimitFailoverDeps,
  bot: Bot,
  current: Pick<BotBackupModelEntry, 'agent' | 'model'>,
  available: ReadonlySet<BotAgent>,
  attempted?: ReadonlySet<string>
): Promise<BotBackupModelEntry | undefined> {
  const order = bot.backupModels?.order ?? []
  for (const candidate of order) {
    if (
      sameBotModelTarget(candidate, current) ||
      !available.has(candidate.agent) ||
      // A same-agent backup without a concrete model cannot move the session off the limited model.
      (candidate.agent === current.agent && !candidate.model)
    ) {
      continue
    }
    if (attempted?.has(botModelTargetKey(candidate))) {
      continue
    }
    const key: BotUsageLimitKey = {
      agent: candidate.agent,
      accountHomeKey: await deps.resolveAccountHomeKey(candidate.agent),
      model: candidate.model ?? ''
    }
    if (!deps.gate.isLimited(key)) {
      return candidate
    }
  }
  return undefined
}

export async function executeBotBackupSwitch(
  deps: BotUsageLimitFailoverDeps,
  withProgrammaticOptions: <T>(sessionId: string, run: () => Promise<T>) => Promise<T>,
  input: {
    bot: Bot
    session: BotFailoverSessionInfo
    cut: Pick<HostUsageLimitCut, 'turnItemId' | 'resetsAt'>
    target: BotBackupModelEntry
    now: number
  }
): Promise<{ switched: boolean; newSessionId?: string }> {
  const { bot, session, cut, target, now } = input
  const primaryModel = bot.activeBackup?.primaryModel ?? bot.launch?.model ?? session.model
  const primaryResetsAt = bot.activeBackup?.primaryResetsAt ?? cut.resetsAt
  const commitActiveBackup = async (): Promise<void> => {
    await deps.updateBot(bot.id, (latest) => ({
      activeBackup: {
        target,
        switchedAt: now,
        ...((latest.activeBackup?.primaryModel ?? primaryModel)
          ? { primaryModel: latest.activeBackup?.primaryModel ?? primaryModel }
          : {}),
        ...((latest.activeBackup?.primaryResetsAt ?? primaryResetsAt)
          ? { primaryResetsAt: latest.activeBackup?.primaryResetsAt ?? primaryResetsAt }
          : {})
      }
    }))
  }

  if (target.agent === session.provider) {
    if (!target.model) {
      return { switched: false }
    }
    const applied = await withProgrammaticOptions(session.sessionId, () =>
      deps.applySameAgentOptions(session.sessionId, target)
    )
    if (!applied) {
      return { switched: false }
    }
    await commitActiveBackup()
    await deps
      .appendSwitchCard(
        session.sessionId,
        {
          kind: 'bot-backup-model-switch',
          switchId: randomUUID(),
          botId: bot.id,
          direction: 'to-backup',
          fromAgent: session.provider,
          ...(session.model ? { fromModel: session.model } : {}),
          toAgent: target.agent,
          toModel: target.model,
          ...(cut.resetsAt !== undefined ? { resetsAt: cut.resetsAt } : {}),
          at: now
        },
        now
      )
      .catch(() => {})
    const continued = await deps.sendSameAgentContinuation(
      session.sessionId,
      cut,
      session.runtimeFence
    )
    return { switched: continued }
  }

  const latestBot = deps.listBots().find((entry) => entry.id === bot.id) ?? bot
  const handedOff = await executeCrossAgentBotHandoff(deps.crossAgentHandoff, {
    bot: latestBot,
    sourceSessionId: session.sessionId,
    sourceAgent: session.provider,
    sourceModel: session.model,
    target,
    direction: 'to-backup',
    resetsAt: cut.resetsAt,
    now
  })
  await commitActiveBackup()
  return { switched: true, newSessionId: handedOff.newSessionId }
}

export async function returnHomeChatToPrimary(
  deps: BotUsageLimitFailoverDeps,
  withProgrammaticOptions: <T>(sessionId: string, run: () => Promise<T>) => Promise<T>,
  input: {
    bot: Bot
    home: BotFailoverSessionInfo
    fromTarget: BotBackupModelEntry
    primaryModel: string | undefined
    manual?: boolean
    now: number
  }
): Promise<boolean> {
  const { bot, home, fromTarget, primaryModel, manual, now } = input
  const returnReason = manual ? ('manual' as const) : ('limit-reset' as const)
  const primaryTarget = botPrimaryTarget(bot)
  if (home.provider === bot.agent) {
    const restoreTarget = primaryModel ? { ...primaryTarget, model: primaryModel } : primaryTarget
    const applied = await withProgrammaticOptions(home.sessionId, () =>
      deps.applySameAgentOptions(home.sessionId, restoreTarget)
    ).catch(() => false)
    if (!applied) {
      return false
    }
    await deps
      .appendSwitchCard(
        home.sessionId,
        {
          kind: 'bot-backup-model-switch',
          switchId: randomUUID(),
          botId: bot.id,
          direction: 'to-primary',
          returnReason,
          fromAgent: fromTarget.agent,
          ...(fromTarget.model ? { fromModel: fromTarget.model } : {}),
          toAgent: bot.agent,
          ...(primaryModel ? { toModel: primaryModel } : {}),
          at: now
        },
        now
      )
      .catch(() => {})
    return true
  }
  const refreshed = deps.listBots().find((entry) => entry.id === bot.id) ?? bot
  try {
    await executeCrossAgentBotHandoff(deps.crossAgentHandoff, {
      bot: refreshed,
      sourceSessionId: home.sessionId,
      sourceAgent: home.provider,
      sourceModel: home.model ?? fromTarget.model,
      target: primaryTarget,
      direction: 'to-primary',
      returnReason,
      now
    })
    return true
  } catch {
    return false
  }
}

/** Resolves the setup a new bot session or automation run should launch with. */
export async function resolveBotLaunchSetup(
  deps: BotUsageLimitFailoverDeps,
  bot: Bot,
  now: number
): Promise<{ agent: BotAgent; launch?: Bot['launch'] }> {
  const effective = effectiveBotSetup(bot)
  const accountHomeKey = await deps.resolveAccountHomeKey(bot.agent)
  const primaryKey: BotUsageLimitKey = {
    agent: bot.agent,
    accountHomeKey,
    model: bot.launch?.model ?? ''
  }
  if (!effective.onBackup && deps.gate.isLimited(primaryKey) && bot.backupModels?.automatic) {
    const available = await deps.availableAgents()
    const ready = await pickReadyBotBackup(deps, bot, botPrimaryTarget(bot), available)
    if (ready) {
      const launch = backupEntryToLaunch(ready)
      const resetsAt = deps.gate.limitResetAt(primaryKey)
      await deps
        .updateBot(bot.id, () => ({
          activeBackup: {
            target: ready,
            switchedAt: now,
            ...(bot.launch?.model ? { primaryModel: bot.launch.model } : {}),
            ...(resetsAt !== undefined ? { primaryResetsAt: resetsAt } : {})
          }
        }))
        .catch(() => {})
      return { agent: ready.agent, ...(launch ? { launch } : {}) }
    }
  }
  return { agent: effective.agent, ...(effective.launch ? { launch: effective.launch } : {}) }
}
