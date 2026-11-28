import { isDeepStrictEqual } from 'node:util'
import type { Bot, BotAgent } from '../../shared/bot-types'
import {
  backupEntryToLaunch,
  botModelTargetKey,
  botPrimaryTarget,
  effectiveBotSetup,
  sameBotModelTarget,
  type BotBackupModelEntry
} from '../../shared/bots/bot-backup-models'
import type { HostUsageLimitCut } from '../native-chat/agent-session-wire/recovery/structured-agent-session-usage-limit-chain'
import {
  executeBotBackupSwitch,
  type BotFailoverSessionInfo,
  type BotUsageLimitFailoverDeps
} from './bot-usage-limit-failover-execution'
import { BotHandoffRollbackError } from './bot-cross-agent-handoff'
import type { BotBackupActions } from './bot-usage-limit-failover-actions'
import type { BotUsageLimitKey } from './bot-usage-limit-gate'

export type BotLaunchSelection = {
  agent: BotAgent
  launch?: Bot['launch']
  markActive?: () => Promise<void>
}

export function sameBackupPolicy(left: Bot, right: Bot): boolean {
  return (
    left.paused === right.paused &&
    isDeepStrictEqual(botPrimaryTarget(left), botPrimaryTarget(right)) &&
    isDeepStrictEqual(left.backupModels, right.backupModels)
  )
}

export async function pickReadyBotBackup(
  deps: BotUsageLimitFailoverDeps,
  bot: Bot,
  current: Pick<BotBackupModelEntry, 'agent' | 'model'> & { sessionId?: string },
  available: ReadonlySet<BotAgent>,
  attempted?: ReadonlySet<string>
): Promise<{ target: BotBackupModelEntry; key: BotUsageLimitKey } | undefined> {
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
    const sameAgentSession = candidate.agent === current.agent ? current.sessionId : undefined
    if (
      candidate.model &&
      deps.isBackupModelOffered &&
      !(await deps.isBackupModelOffered(bot, candidate, sameAgentSession))
    ) {
      continue
    }
    const key: BotUsageLimitKey = {
      agent: candidate.agent,
      accountHomeKey: await deps.resolveAccountHomeKey(candidate.agent, sameAgentSession),
      model: candidate.model ?? ''
    }
    if (await deps.gate.verifyReturnReady(key)) {
      return { target: candidate, key }
    }
  }
  return undefined
}

/** A fresh backup becomes active only after a chat was created on it. */
export async function resolveBotLaunchSetup(
  deps: BotUsageLimitFailoverDeps,
  bot: Bot,
  now: number
): Promise<BotLaunchSelection> {
  const latest = () => deps.listBots().find((entry) => entry.id === bot.id) ?? bot
  for (;;) {
    const current = latest()
    const effective = effectiveBotSetup(current)
    if (effective.onBackup || !current.backupModels?.automatic || current.paused) {
      return effective
    }
    const primary = botPrimaryTarget(current)
    const accountHomeKey = await deps.resolveAccountHomeKey(primary.agent)
    const primaryKey = { agent: primary.agent, accountHomeKey, model: primary.model ?? '' }
    if (!deps.gate.isLimited(primaryKey)) {
      return effectiveBotSetup(latest())
    }
    const ready = await pickReadyBotBackup(deps, current, primary, await deps.availableAgents())
    const afterLookup = latest()
    if (afterLookup.activeBackup) {
      return effectiveBotSetup(afterLookup)
    }
    if (!sameBackupPolicy(current, afterLookup) || (ready && deps.gate.isLimited(ready.key))) {
      continue
    }
    if (!ready || !deps.gate.isLimited(primaryKey)) {
      return effective
    }
    const resetsAt = deps.gate.limitResetAt(primaryKey)
    return {
      agent: ready.target.agent,
      launch: backupEntryToLaunch(ready.target),
      markActive: async () => {
        await deps.updateBot(bot.id, (stored) =>
          !stored.activeBackup &&
          sameBackupPolicy(current, stored) &&
          !deps.gate.isLimited(ready.key) &&
          deps.gate.isLimited(primaryKey)
            ? {
                activeBackup: {
                  target: ready.target,
                  switchedAt: now,
                  ...(primary.model ? { primaryModel: primary.model } : {}),
                  ...(resetsAt !== undefined ? { primaryResetsAt: resetsAt } : {})
                }
              }
            : {}
        )
      }
    }
  }
}

type CutSelection =
  | { state: 'stale' }
  | { state: 'ask-backup' | 'backups-exhausted'; bot: Bot }
  | { state: 'switched'; superseded: boolean }

export async function isCurrentBotCut(
  deps: BotUsageLimitFailoverDeps,
  session: BotFailoverSessionInfo,
  cut: HostUsageLimitCut
): Promise<boolean> {
  const liveSession = await deps.getSessionInfo(session.sessionId)
  return (
    liveSession?.isIdle === true &&
    liveSession.runtimeFence === session.runtimeFence &&
    liveSession.provider === session.provider &&
    liveSession.model === session.model &&
    (await deps.readSessionCut(session.sessionId))?.turnItemId === cut.turnItemId
  )
}

export async function selectAndSwitchBotBackup(
  { deps, now, withProgrammaticOptions }: BotBackupActions,
  input: {
    botId: string
    session: BotFailoverSessionInfo
    cut: HostUsageLimitCut
    attempted: Set<string>
    wasHomeChat: boolean
    onSwitching: () => void
  }
): Promise<CutSelection> {
  const { botId, session, cut, attempted, wasHomeChat, onSwitching } = input
  const { sessionId, provider: agent, model } = session
  const readBot = () => deps.botOfSession(sessionId)
  const available = await deps.availableAgents()
  for (;;) {
    const bot = readBot()
    if (
      bot?.id !== botId ||
      bot.paused ||
      !bot.backupModels?.order.length ||
      (wasHomeChat && bot.chatSessionId !== sessionId)
    ) {
      return { state: 'stale' }
    }
    const ready = await pickReadyBotBackup(
      deps,
      bot,
      { agent, model, sessionId },
      available,
      attempted
    )
    if (!(await isCurrentBotCut(deps, session, cut))) {
      return { state: 'stale' }
    }
    const current = readBot()
    if (current?.id !== botId) {
      return { state: 'stale' }
    }
    if (!sameBackupPolicy(bot, current) || (ready && deps.gate.isLimited(ready.key))) {
      continue
    }
    if (!ready || !bot.backupModels.automatic) {
      return { state: ready ? 'ask-backup' : 'backups-exhausted', bot }
    }
    const targetKey = botModelTargetKey(ready.target)
    try {
      const result = await executeBotBackupSwitch(deps, withProgrammaticOptions, {
        bot,
        session,
        cut,
        target: ready.target,
        now: now(),
        maySwitch: async () => {
          const live = await isCurrentBotCut(deps, session, cut)
          const latest = readBot()
          if (
            !live ||
            latest?.id !== botId ||
            !sameBackupPolicy(bot, latest) ||
            (wasHomeChat && latest.chatSessionId !== sessionId) ||
            deps.gate.isLimited(ready.key)
          ) {
            return false
          }
          attempted.add(targetKey)
          onSwitching()
          return true
        }
      })
      if (result.switched) {
        return { state: 'switched', superseded: result.newSessionId !== undefined }
      }
    } catch (error) {
      if (error instanceof BotHandoffRollbackError) {
        console.warn('[bots] could not complete a backup switch safely', error)
        return { state: 'backups-exhausted', bot }
      }
      attempted.add(targetKey)
    }
  }
}
