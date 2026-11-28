// Execution helpers and shared contracts for bot usage-limit failover and return-to-primary.
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Bot, BotAgent } from '../../shared/bot-types'
import {
  botPrimaryTarget,
  type BotActiveBackup,
  type BotBackupModelEntry
} from '../../shared/bots/bot-backup-models'
import type { AgentJournalBotBackupModelSwitchItem } from '../../shared/agent-journal-orca-card-items'
import type { HostUsageLimitCut } from '../native-chat/agent-session-wire/recovery/structured-agent-session-usage-limit-chain'
import {
  BotHandoffRollbackError,
  executeCrossAgentBotHandoff,
  type BotCrossAgentHandoffDeps
} from './bot-cross-agent-handoff'
import type { BotUsageLimitGate } from './bot-usage-limit-gate'

export type BotCutBackupState = {
  turnItemId: string
  backupState: 'switching' | 'ask-backup' | 'backups-exhausted'
  backupResetsAt?: number
}

export type BotFailoverSessionInfo = {
  sessionId: string
  provider: BotAgent
  model?: string
  options?: Record<string, string>
  isIdle: boolean
  runtimeFence: number
}

export type BotBackupSwitchResult = {
  switched: boolean
  continued?: boolean
  newSessionId?: string
}

export type BotAppliedBackupOptions = { target: BotBackupModelEntry; complete: boolean }

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
  isBackupModelOffered?: (
    bot: Bot,
    target: BotBackupModelEntry,
    sessionId?: string
  ) => Promise<boolean>
  /** Applies model and optional execution options in-place on an existing same-agent session. */
  applySameAgentOptions: (
    sessionId: string,
    target: BotBackupModelEntry
  ) => Promise<BotAppliedBackupOptions | null>
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
  holdTurnWatch?: (sessionId: string) => () => void
  /** Lists active session ids for `botId` so config edits can re-evaluate held cuts. */
  listBotSessionIds?: (botId: string) => readonly string[]
  /** Reads the latest usage-limit cut for a session if still sitting at one. */
  readSessionCut: (sessionId: string) => Promise<HostUsageLimitCut | null>
  crossAgentHandoff: BotCrossAgentHandoffDeps
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
    maySwitch?: () => Promise<boolean>
  }
): Promise<BotBackupSwitchResult> {
  const { bot, session, cut, target, now, maySwitch } = input
  const primaryModel =
    bot.activeBackup?.primaryModel ??
    bot.launch?.model ??
    (session.provider === bot.agent && !bot.activeBackup ? session.model : undefined)
  const primaryResetsAt = bot.activeBackup ? bot.activeBackup.primaryResetsAt : cut.resetsAt
  const commitActiveBackup = async (applied: BotBackupModelEntry) => {
    let prior: BotActiveBackup | undefined
    const stored = await deps
      .updateBot(bot.id, (latest) => {
        prior = latest.activeBackup
        return {
          activeBackup: {
            target: applied,
            switchedAt: now,
            ...((latest.activeBackup?.primaryModel ?? primaryModel)
              ? { primaryModel: latest.activeBackup?.primaryModel ?? primaryModel }
              : {}),
            ...((latest.activeBackup?.primaryResetsAt ?? primaryResetsAt)
              ? { primaryResetsAt: latest.activeBackup?.primaryResetsAt ?? primaryResetsAt }
              : {})
          }
        }
      })
      .catch((error: unknown) => {
        throw new BotHandoffRollbackError([error], 'Could not save the active backup')
      })
    return { prior, active: stored.activeBackup }
  }

  if (target.agent === session.provider) {
    if (!target.model || (maySwitch && !(await maySwitch()))) {
      return { switched: false }
    }
    const minimalTarget: BotBackupModelEntry = { agent: target.agent, model: target.model }
    const { prior, active } = await commitActiveBackup(minimalTarget)
    const allowed = await maySwitch?.()
    const applied =
      allowed === false
        ? null
        : await withProgrammaticOptions(session.sessionId, () =>
            deps.applySameAgentOptions(session.sessionId, target)
          ).catch(async () =>
            (await deps.getSessionInfo(session.sessionId))?.model === target.model
              ? { target: minimalTarget, complete: false }
              : null
          )
    if (!applied) {
      try {
        await deps.updateBot(bot.id, (latest) =>
          isDeepStrictEqual(latest.activeBackup, active) ? { activeBackup: prior ?? null } : {}
        )
      } catch (error) {
        throw new BotHandoffRollbackError([error], 'Could not restore the previously active backup')
      }
      return { switched: false }
    }
    if (applied.target.options) {
      await deps
        .updateBot(bot.id, (latest) =>
          active && isDeepStrictEqual(latest.activeBackup, active)
            ? { activeBackup: { ...active, target: applied.target } }
            : {}
        )
        .catch((error: unknown) =>
          console.warn('[bots] could not record applied backup options', error)
        )
    }
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
    const continued =
      applied.complete &&
      (await deps
        .sendSameAgentContinuation(session.sessionId, cut, session.runtimeFence)
        .catch(() => false))
    return { switched: true, continued }
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
    now,
    maySwitch
  })
  if (!handedOff) {
    return { switched: false }
  }
  await commitActiveBackup(target)
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
    mayReturn: () => Promise<boolean>
  }
): Promise<boolean> {
  const { bot, home, fromTarget, primaryModel, manual, now, mayReturn } = input
  const returnReason = manual ? ('manual' as const) : ('limit-reset' as const)
  const primaryTarget = botPrimaryTarget(bot)
  const canRestoreInPlace =
    home.provider === bot.agent &&
    home.model &&
    primaryModel &&
    Object.keys(fromTarget.options ?? {}).every((key) => key in (primaryTarget.options ?? {}))
  let partial = false
  if (canRestoreInPlace) {
    if (!(await mayReturn())) {
      return false
    }
    const restoreTarget = { ...primaryTarget, model: primaryModel }
    const applied = await withProgrammaticOptions(home.sessionId, () =>
      deps.applySameAgentOptions(home.sessionId, restoreTarget)
    ).catch(() => null)
    if (!applied) {
      return false
    }
    partial = !applied.complete
  }
  if (canRestoreInPlace && !partial) {
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
  try {
    const handoff = await executeCrossAgentBotHandoff(deps.crossAgentHandoff, {
      bot,
      sourceSessionId: home.sessionId,
      sourceAgent: home.provider,
      sourceModel: home.model ?? fromTarget.model,
      target: primaryTarget,
      direction: 'to-primary',
      returnReason,
      now,
      maySwitch: mayReturn
    })
    if (handoff) {
      return true
    }
  } catch (error) {
    if (error instanceof BotHandoffRollbackError) {
      console.warn('[bots] could not roll back the primary handoff', error)
    }
  }
  if (partial) {
    const restored = await withProgrammaticOptions(home.sessionId, () =>
      deps.applySameAgentOptions(home.sessionId, {
        agent: home.provider,
        model: home.model,
        options: home.options
      })
    ).catch(() => null)
    if (!restored?.complete) {
      console.warn('[bots] could not restore backup options after a partial primary return')
    }
  }
  return false
}
