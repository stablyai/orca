import { randomUUID } from 'node:crypto'
import type { Bot } from '../../shared/bot-types'
import {
  botPrimaryTarget,
  rememberedBotBackupModels,
  sameBotModelTarget,
  type BotBackupModelEntry,
  type BotBackupSwitchParams
} from '../../shared/bots/bot-backup-models'
import type { HostUsageLimitCut } from '../native-chat/agent-session-wire/recovery/structured-agent-session-usage-limit-chain'
import {
  executeBotBackupSwitch,
  type BotBackupSwitchResult,
  type BotCutBackupState,
  type BotFailoverSessionInfo,
  type BotUsageLimitFailoverDeps
} from './bot-usage-limit-failover-execution'
import type { BotUsageLimitKey } from './bot-usage-limit-gate'
import { readCurrentBotCut } from './bot-backup-target-selection'
import { BotHandoffRollbackError, executeCrossAgentBotHandoff } from './bot-cross-agent-handoff'

export type BotBackupActions = {
  deps: BotUsageLimitFailoverDeps
  withProgrammaticOptions: <T>(id: string, run: () => Promise<T>) => Promise<T>
  now: () => number
}

export async function switchBackupManually(
  { deps, withProgrammaticOptions, now }: BotBackupActions,
  params: BotBackupSwitchParams,
  state: {
    isHandled: (id: string, turn: string) => boolean
    complete: (id: string, cut: HostUsageLimitCut, superseded: boolean) => void
    switching: Set<string>
  }
): Promise<BotBackupSwitchResult> {
  const { botId, sessionId, turnItemId, target } = params
  if (!deps.listBots().some((bot) => bot.id === botId)) {
    throw new Error('bot_not_found')
  }
  const session = await deps.getSessionInfo(sessionId)
  if (!session) {
    throw new Error('session_not_found')
  }
  const bot = deps.botOfSession(sessionId)
  if (bot?.id !== botId) {
    throw new Error('session_bot_mismatch')
  }
  const cut = await deps.readSessionCut(sessionId)
  if (!session.isIdle || cut?.turnItemId !== turnItemId || state.isHandled(sessionId, turnItemId)) {
    throw new Error('usage_limit_cut_changed')
  }
  if (sameBotModelTarget(target, { agent: session.provider, model: session.model })) {
    return { switched: false }
  }
  const key = `${sessionId}:${turnItemId}`
  state.switching.add(key)
  const releaseWatch = deps.holdTurnWatch?.(sessionId)
  try {
    const result = await executeBotBackupSwitch(deps, withProgrammaticOptions, {
      bot,
      session,
      cut,
      target,
      now: now(),
      maySwitch: async () =>
        (await readCurrentBotCut(deps, session, cut)) !== null &&
        deps.botOfSession(sessionId)?.id === botId
    })
    if (result.switched) {
      state.complete(sessionId, cut, result.newSessionId !== undefined)
      if (params.remember) {
        await deps.updateBot(botId, (latest) => ({
          backupModels:
            rememberedBotBackupModels(target, latest.backupModels, botPrimaryTarget(latest)) ?? null
        }))
      }
    }
    return result.switched ? result : { switched: false }
  } finally {
    state.switching.delete(key)
    releaseWatch?.()
  }
}

export async function returnBackupToPrimary(
  { deps, withProgrammaticOptions, now }: BotBackupActions,
  botId: string,
  force: boolean,
  pendingForcedReturns: Set<string>
): Promise<boolean> {
  const bot = deps.listBots().find((entry) => entry.id === botId)
  if (!bot?.activeBackup) {
    pendingForcedReturns.delete(botId)
    return false
  }
  const active = bot.activeBackup
  const primaryModel = bot.launch?.model ?? bot.activeBackup.primaryModel
  const primaryKey = force
    ? null
    : {
        agent: bot.agent,
        accountHomeKey: await deps.resolveAccountHomeKey(bot.agent, bot.chatSessionId ?? undefined),
        model: primaryModel ?? ''
      }
  if (primaryKey && !(await deps.gate.verifyReturnReady(primaryKey))) {
    return false
  }
  const home = bot.chatSessionId ? await deps.getSessionInfo(bot.chatSessionId) : null
  if (home && !home.isIdle) {
    if (force) {
      pendingForcedReturns.add(botId)
    }
    return false
  }
  const isSameBackup = (latest: typeof bot) =>
    latest.activeBackup?.switchedAt === active.switchedAt &&
    sameBotModelTarget(latest.activeBackup.target, active.target)
  const mayReturn = async () => {
    const live = home ? await deps.getSessionInfo(home.sessionId) : null
    const latest = deps.listBots().find((entry) => entry.id === botId)
    return (
      !!latest &&
      latest.chatSessionId === bot.chatSessionId &&
      isSameBackup(latest) &&
      (!home || (live?.isIdle === true && live.runtimeFence === home.runtimeFence)) &&
      (!primaryKey || !deps.gate.isLimited(primaryKey))
    )
  }
  let expectedHomeSessionId = bot.chatSessionId
  if (home) {
    const returnedSessionId = await returnHomeChatToPrimary(deps, withProgrammaticOptions, {
      bot,
      home,
      fromTarget: bot.activeBackup.target,
      primaryModel,
      manual: force,
      now: now(),
      mayReturn
    })
    if (!returnedSessionId) {
      return false
    }
    expectedHomeSessionId = returnedSessionId
  }
  const returned = await deps.updateBot(botId, (latest) =>
    isSameBackup(latest) &&
    latest.chatSessionId === expectedHomeSessionId &&
    (home || !primaryKey || !deps.gate.isLimited(primaryKey))
      ? { activeBackup: null }
      : {}
  )
  if (returned.activeBackup) {
    return false
  }
  pendingForcedReturns.delete(botId)
  return true
}

async function returnHomeChatToPrimary(
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
): Promise<string | null> {
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
      return null
    }
    const restoreTarget = { ...primaryTarget, model: primaryModel }
    const applied = await withProgrammaticOptions(home.sessionId, () =>
      deps.applySameAgentOptions(home.sessionId, restoreTarget)
    ).catch(() => null)
    if (!applied) {
      return null
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
    return home.sessionId
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
      return handoff.newSessionId
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
  return null
}

export async function reconsiderReleasedLimit(
  deps: BotUsageLimitFailoverDeps,
  released: BotUsageLimitKey,
  state: {
    cuts: ReadonlyMap<string, BotCutBackupState>
    observedKey: (id: string) => BotUsageLimitKey | undefined
    returnToPrimary: (botId: string) => Promise<boolean>
    reconsider: (id: string, cut: HostUsageLimitCut) => Promise<void>
  }
): Promise<void> {
  for (const bot of deps.listBots()) {
    if (!bot.activeBackup || bot.agent !== released.agent) {
      continue
    }
    const primaryModel = bot.launch?.model ?? bot.activeBackup.primaryModel ?? ''
    if (
      primaryModel === released.model &&
      (await deps.resolveAccountHomeKey(bot.agent, bot.chatSessionId ?? undefined)) ===
        released.accountHomeKey
    ) {
      await state.returnToPrimary(bot.id).catch(() => {})
    }
  }
  for (const [sessionId, cutState] of state.cuts) {
    if (cutState.backupState !== 'backups-exhausted' && cutState.backupState !== 'ask-backup') {
      continue
    }
    const bot = deps.botOfSession(sessionId)
    if (!bot) {
      continue
    }
    const observed = state.observedKey(sessionId)
    const currentReleased =
      sameBotModelTarget(observed, released) && observed?.accountHomeKey === released.accountHomeKey
    const backupReleased = bot.backupModels?.order.some((entry) =>
      sameBotModelTarget(entry, released)
    )
    if (currentReleased || backupReleased) {
      const cut = await deps.readSessionCut(sessionId)
      if (cut?.turnItemId === cutState.turnItemId) {
        await state.reconsider(sessionId, cut)
      }
    }
  }
}
