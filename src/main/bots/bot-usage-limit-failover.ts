// Coordinates bot usage-limit failover (same-agent in-place & cross-agent handoff) and return to primary.
import type { Bot, BotAgent } from '../../shared/bot-types'
import {
  botModelTargetKey,
  botPrimaryTarget,
  rememberedBotBackupModels,
  type BotBackupSwitchParams
} from '../../shared/bots/bot-backup-models'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import type { HostUsageLimitCut } from '../native-chat/agent-session-wire/recovery/structured-agent-session-usage-limit-chain'
import type { BotUsageLimitKey } from './bot-usage-limit-gate'
import {
  executeBotBackupSwitch,
  pickReadyBotBackup,
  resolveBotLaunchSetup,
  returnHomeChatToPrimary,
  type BotCutBackupState,
  type BotFailoverSessionInfo,
  type BotUsageLimitFailoverDeps
} from './bot-usage-limit-failover-execution'

export type { BotCutBackupState, BotFailoverSessionInfo, BotUsageLimitFailoverDeps }

export class BotUsageLimitFailover {
  private readonly botQueues = new Map<string, Promise<void>>()
  private readonly cutStates = new Map<string, BotCutBackupState>()
  private readonly attemptedByCut = new Map<string, Set<string>>()
  private readonly inFlightCuts = new Set<string>()
  private readonly pendingForcedReturns = new Set<string>()
  private readonly programmaticOptionSessions = new Set<string>()
  private readonly now: () => number

  constructor(private readonly deps: BotUsageLimitFailoverDeps) {
    this.now = deps.now ?? Date.now
  }

  /** True while failover itself is mutating options on `sessionId` (not a manual owner pick). */
  isProgrammaticOptionChange(sessionId: string): boolean {
    return this.programmaticOptionSessions.has(sessionId)
  }

  readCutBackupState(sessionId: string, turnItemId: string): BotCutBackupState | undefined {
    const state = this.cutStates.get(sessionId)
    return state?.turnItemId === turnItemId ? state : undefined
  }

  isFailoverSwitching(sessionId: string, turnItemId: string): boolean {
    return this.readCutBackupState(sessionId, turnItemId)?.backupState === 'switching'
  }

  /** Resolves the setup a new bot session or automation run should launch with. */
  async resolveLaunchSetup(bot: Bot): Promise<{ agent: BotAgent; launch?: Bot['launch'] }> {
    return resolveBotLaunchSetup(this.deps, bot, this.now())
  }

  /** Called when a structured session observes a usage-limit cut. */
  async onUsageLimitCut(sessionId: string, cut: HostUsageLimitCut): Promise<void> {
    const bot = this.deps.botOfSession(sessionId)
    if (!bot || bot.paused) {
      return
    }
    const dedupeKey = `${sessionId}:${cut.turnItemId}`
    if (this.inFlightCuts.has(dedupeKey)) {
      return
    }
    this.inFlightCuts.add(dedupeKey)
    try {
      await runKeyedSerializedOperation(this.botQueues, bot.id, async () => {
        await this.handleCutSerialized(bot.id, sessionId, cut)
      })
    } finally {
      this.inFlightCuts.delete(dedupeKey)
    }
  }

  /** Manual owner action from the inline usage-limit card (`bots.backup.switch`). */
  async switchSessionManually(
    params: BotBackupSwitchParams
  ): Promise<{ switched: boolean; newSessionId?: string }> {
    return runKeyedSerializedOperation(this.botQueues, params.botId, async () => {
      const bot = this.deps.listBots().find((entry) => entry.id === params.botId)
      if (!bot) {
        throw new Error('bot_not_found')
      }
      const session = await this.deps.getSessionInfo(params.sessionId)
      if (!session) {
        throw new Error('session_not_found')
      }
      if (this.deps.botOfSession(params.sessionId)?.id !== bot.id) {
        throw new Error('session_bot_mismatch')
      }
      if (params.remember) {
        await this.deps.updateBot(bot.id, (latest) => ({
          backupModels:
            rememberedBotBackupModels(
              params.target,
              latest.backupModels,
              botPrimaryTarget(latest)
            ) ?? null
        }))
      }
      const readCut = await this.deps.readSessionCut?.(params.sessionId)
      const cut: Pick<HostUsageLimitCut, 'turnItemId' | 'resetsAt'> = {
        turnItemId: params.turnItemId,
        ...(readCut?.resetsAt !== undefined ? { resetsAt: readCut.resetsAt } : {})
      }
      const latestBot = this.deps.listBots().find((entry) => entry.id === bot.id) ?? bot
      const result = await executeBotBackupSwitch(
        this.deps,
        (sid, run) => this.withProgrammaticOptions(sid, run),
        { bot: latestBot, session, cut, target: params.target, now: this.now() }
      )
      this.clearCutState(session.sessionId)
      return result
    })
  }

  /** Returns a bot on an active backup back to its primary model once verified ready (or forced). */
  async returnToPrimary(botId: string, options: { force?: boolean } = {}): Promise<boolean> {
    return runKeyedSerializedOperation(this.botQueues, botId, async () => {
      const bot = this.deps.listBots().find((entry) => entry.id === botId)
      if (!bot?.activeBackup) {
        return false
      }
      const primaryModel = bot.launch?.model ?? bot.activeBackup.primaryModel
      const primaryKey = await this.limitKeyFor(bot.agent, primaryModel)
      if (!options.force && !(await this.deps.gate.verifyReturnReady(primaryKey))) {
        return false
      }
      const home = bot.chatSessionId ? await this.deps.getSessionInfo(bot.chatSessionId) : null
      // Never interrupt an active Home Chat turn; remember forced requests so onTurnSucceeded completes them.
      if (home && !home.isIdle) {
        if (options.force) {
          this.pendingForcedReturns.add(bot.id)
        }
        return false
      }
      const fromTarget = bot.activeBackup.target
      if (home) {
        const returned = await returnHomeChatToPrimary(
          this.deps,
          (sid, run) => this.withProgrammaticOptions(sid, run),
          { bot, home, fromTarget, primaryModel, manual: options.force === true, now: this.now() }
        )
        if (!returned) {
          return false
        }
      }
      this.pendingForcedReturns.delete(bot.id)
      await this.deps.updateBot(bot.id, () => ({ activeBackup: null }))
      return true
    })
  }

  /** Re-evaluates held sessions when a bot's backup config changes (e.g., automatic enabled). */
  async onBackupConfigChanged(botId: string): Promise<void> {
    const sessions = this.deps.listBotSessionIds?.(botId) ?? []
    for (const sessionId of sessions) {
      const cut = await this.deps.readSessionCut?.(sessionId)
      if (cut) {
        await this.onUsageLimitCut(sessionId, cut)
      }
    }
  }

  /** Called by BotUsageLimitGate when a held limit releases; returns any waiting bots to primary. */
  async onLimitReleased(released: BotUsageLimitKey): Promise<void> {
    for (const bot of this.deps.listBots()) {
      if (!bot.activeBackup || bot.agent !== released.agent) {
        continue
      }
      const primaryModel = bot.launch?.model ?? bot.activeBackup.primaryModel ?? ''
      if (primaryModel === released.model) {
        await this.returnToPrimary(bot.id).catch(() => {})
      }
    }
  }

  /** Clears limit holds and cut retry guards when a session completes a turn normally. */
  async onTurnSucceeded(sessionId: string): Promise<void> {
    const session = await this.deps.getSessionInfo(sessionId)
    if (session) {
      const accountHomeKey = await this.deps.resolveAccountHomeKey(session.provider, sessionId)
      this.deps.gate.recordSuccess({
        agent: session.provider,
        accountHomeKey,
        model: session.model ?? ''
      })
    }
    this.clearCutState(sessionId)
    const prefix = `${sessionId}:`
    for (const key of this.attemptedByCut.keys()) {
      if (key.startsWith(prefix)) {
        this.attemptedByCut.delete(key)
      }
    }
    const bot = this.deps.botOfSession(sessionId)
    if (bot?.activeBackup && bot.chatSessionId === sessionId) {
      if (this.pendingForcedReturns.has(bot.id)) {
        await this.returnToPrimary(bot.id, { force: true }).catch(() => {})
      } else {
        const primaryModel = bot.launch?.model ?? bot.activeBackup.primaryModel
        const primaryKey = await this.limitKeyFor(bot.agent, primaryModel)
        if (!this.deps.gate.isLimited(primaryKey)) {
          await this.returnToPrimary(bot.id).catch(() => {})
        }
      }
    }
  }

  private async handleCutSerialized(
    botId: string,
    sessionId: string,
    cut: HostUsageLimitCut
  ): Promise<void> {
    const bot = this.deps.listBots().find((entry) => entry.id === botId)
    const session = bot && !bot.paused ? await this.deps.getSessionInfo(sessionId) : null
    if (!bot || !session) {
      return
    }
    const accountHomeKey = await this.deps.resolveAccountHomeKey(session.provider, sessionId)
    this.deps.gate.recordLimit({
      agent: session.provider,
      accountHomeKey,
      model: session.model ?? '',
      ...(cut.resetsAt !== undefined ? { resetsAt: cut.resetsAt } : {})
    })

    const backups = bot.backupModels
    if (!backups || backups.order.length === 0) {
      this.clearCutState(sessionId)
      return
    }

    const available = await this.deps.availableAgents()
    const currentChoice = {
      agent: session.provider,
      ...(session.model ? { model: session.model } : {})
    }
    const cutKey = `${sessionId}:${cut.turnItemId}`
    const attempted = this.attemptedByCut.get(cutKey) ?? new Set<string>()
    attempted.add(botModelTargetKey(currentChoice))
    this.attemptedByCut.set(cutKey, attempted)

    const ready = await pickReadyBotBackup(this.deps, bot, currentChoice, available, attempted)
    if (!backups.automatic) {
      if (ready) {
        this.setCutState(sessionId, { turnItemId: cut.turnItemId, backupState: 'ask-backup' })
      } else {
        await this.markBackupsExhausted(bot, sessionId, cut)
      }
      return
    }

    if (!ready) {
      await this.markBackupsExhausted(bot, sessionId, cut)
      return
    }

    this.setCutState(sessionId, { turnItemId: cut.turnItemId, backupState: 'switching' })
    let candidate: typeof ready | undefined = ready
    while (candidate) {
      attempted.add(botModelTargetKey(candidate))
      let switched = false
      try {
        const result = await executeBotBackupSwitch(
          this.deps,
          (sid, run) => this.withProgrammaticOptions(sid, run),
          { bot, session, cut, target: candidate, now: this.now() }
        )
        switched = result.switched
      } catch {
        switched = false
      }
      if (switched) {
        this.clearCutState(sessionId)
        return
      }
      candidate = await pickReadyBotBackup(this.deps, bot, currentChoice, available, attempted)
    }
    await this.markBackupsExhausted(bot, sessionId, cut)
  }

  private async markBackupsExhausted(
    bot: Bot,
    sessionId: string,
    cut: HostUsageLimitCut
  ): Promise<void> {
    const candidates = [botPrimaryTarget(bot), ...(bot.backupModels?.order ?? [])]
    const keys = await Promise.all(
      candidates.map((entry) => this.limitKeyFor(entry.agent, entry.model))
    )
    const earliest = this.deps.gate.earliestResetAt(keys) ?? cut.resetsAt
    this.setCutState(sessionId, {
      turnItemId: cut.turnItemId,
      backupState: 'backups-exhausted',
      ...(earliest !== undefined ? { backupResetsAt: earliest } : {})
    })
  }

  private async limitKeyFor(agent: BotAgent, model = ''): Promise<BotUsageLimitKey> {
    const accountHomeKey = await this.deps.resolveAccountHomeKey(agent)
    return { agent, accountHomeKey, model }
  }

  private setCutState(sessionId: string, next: BotCutBackupState): void {
    const prev = this.cutStates.get(sessionId)
    if (
      prev?.turnItemId === next.turnItemId &&
      prev.backupState === next.backupState &&
      prev.backupResetsAt === next.backupResetsAt
    ) {
      return
    }
    this.cutStates.set(sessionId, next)
    this.deps.publishSessionStatus(sessionId)
  }

  private clearCutState(sessionId: string): void {
    if (this.cutStates.delete(sessionId)) {
      this.deps.publishSessionStatus(sessionId)
    }
  }

  private async withProgrammaticOptions<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    this.programmaticOptionSessions.add(sessionId)
    try {
      return await run()
    } finally {
      this.programmaticOptionSessions.delete(sessionId)
    }
  }
}
