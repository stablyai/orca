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
  type BotCutBackupState,
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

export async function resolveBotUsageLimitKey(
  deps: BotUsageLimitFailoverDeps,
  { agent, model }: Pick<BotBackupModelEntry, 'agent' | 'model'>,
  sessionId?: string
): Promise<BotUsageLimitKey> {
  const accountHomeKey = await deps.resolveAccountHomeKey(agent, sessionId)
  return { agent, accountHomeKey, model: model ?? '' }
}

export async function readBackupsExhaustedState(
  deps: BotUsageLimitFailoverDeps,
  bot: Bot,
  cut: HostUsageLimitCut
): Promise<BotCutBackupState> {
  const candidates = [botPrimaryTarget(bot), ...(bot.backupModels?.order ?? [])]
  const keys = await Promise.all(candidates.map((entry) => resolveBotUsageLimitKey(deps, entry)))
  const earliest = deps.gate.earliestResetAt(keys) ?? cut.resetsAt
  return {
    turnItemId: cut.turnItemId,
    backupState: 'backups-exhausted',
    ...(earliest !== undefined ? { backupResetsAt: earliest } : {})
  }
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
    const key = await resolveBotUsageLimitKey(deps, candidate, sameAgentSession)
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
    const primaryKey = await resolveBotUsageLimitKey(deps, primary)
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
    return {
      agent: ready.target.agent,
      launch: backupEntryToLaunch(ready.target),
      markActive: async () => {
        await deps.updateBot(bot.id, (stored) => {
          if (
            stored.activeBackup ||
            !sameBackupPolicy(current, stored) ||
            deps.gate.isLimited(ready.key) ||
            !deps.gate.isLimited(primaryKey)
          ) {
            return {}
          }
          const resetsAt = deps.gate.limitResetAt(primaryKey)
          return {
            activeBackup: {
              target: ready.target,
              switchedAt: now,
              ...(primary.model ? { primaryModel: primary.model } : {}),
              ...(resetsAt !== undefined ? { primaryResetsAt: resetsAt } : {})
            }
          }
        })
      }
    }
  }
}

type CutSelection =
  | { state: 'stale' }
  | { state: 'ask-backup' | 'backups-exhausted'; bot: Bot }
  | { state: 'switched'; superseded: boolean }

export async function readCurrentBotCut(
  deps: BotUsageLimitFailoverDeps,
  session: BotFailoverSessionInfo,
  cut: HostUsageLimitCut
): Promise<HostUsageLimitCut | null> {
  const liveSession = await deps.getSessionInfo(session.sessionId)
  if (
    !liveSession?.isIdle ||
    liveSession.runtimeFence !== session.runtimeFence ||
    liveSession.provider !== session.provider ||
    liveSession.model !== session.model
  ) {
    return null
  }
  const latestCut = await deps.readSessionCut(session.sessionId)
  return latestCut?.turnItemId === cut.turnItemId ? latestCut : null
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
    const liveCut = await readCurrentBotCut(deps, session, cut)
    if (!liveCut) {
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
        cut: liveCut,
        target: ready.target,
        now: now(),
        maySwitch: async () => {
          const live = await readCurrentBotCut(deps, session, cut)
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
          onSwitching()
          return true
        }
      })
      if (result.switched) {
        return { state: 'switched', superseded: result.newSessionId !== undefined }
      }
      if (result.failure === 'guard-unavailable') {
        return { state: 'stale' }
      }
      if (result.failure === 'apply-failed') {
        attempted.add(targetKey)
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
