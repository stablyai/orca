import {
  botPrimaryTarget,
  rememberedBotBackupModels,
  sameBotModelTarget,
  type BotBackupSwitchParams
} from '../../shared/bots/bot-backup-models'
import type { HostUsageLimitCut } from '../native-chat/agent-session-wire/recovery/structured-agent-session-usage-limit-chain'
import {
  executeBotBackupSwitch,
  returnHomeChatToPrimary,
  type BotBackupSwitchResult,
  type BotCutBackupState,
  type BotUsageLimitFailoverDeps
} from './bot-usage-limit-failover-execution'
import type { BotUsageLimitKey } from './bot-usage-limit-gate'

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
  const cut = await deps.readSessionCut?.(sessionId)
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
      now: now()
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
    return result
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
    return false
  }
  const primaryModel = bot.launch?.model ?? bot.activeBackup.primaryModel
  const accountHomeKey = await deps.resolveAccountHomeKey(bot.agent)
  if (
    !force &&
    !(await deps.gate.verifyReturnReady({
      agent: bot.agent,
      accountHomeKey,
      model: primaryModel ?? ''
    }))
  ) {
    return false
  }
  const home = bot.chatSessionId ? await deps.getSessionInfo(bot.chatSessionId) : null
  if (home && !home.isIdle) {
    if (force) {
      pendingForcedReturns.add(botId)
    }
    return false
  }
  if (
    home &&
    !(await returnHomeChatToPrimary(deps, withProgrammaticOptions, {
      bot,
      home,
      fromTarget: bot.activeBackup.target,
      primaryModel,
      manual: force,
      now: now()
    }))
  ) {
    return false
  }
  pendingForcedReturns.delete(botId)
  const active = bot.activeBackup
  await deps.updateBot(botId, (latest) =>
    latest.activeBackup?.switchedAt === active.switchedAt &&
    sameBotModelTarget(latest.activeBackup.target, active.target)
      ? { activeBackup: null }
      : {}
  )
  return true
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
      (await deps.resolveAccountHomeKey(bot.agent)) === released.accountHomeKey
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
      const cut = await deps.readSessionCut?.(sessionId)
      if (cut?.turnItemId === cutState.turnItemId) {
        await state.reconsider(sessionId, cut)
      }
    }
  }
}
