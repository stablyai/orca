// Coordinates bot usage-limit failover (same-agent in-place & cross-agent handoff) and return to primary.
import type { Bot } from '../../shared/bot-types'
import {
  botModelTargetKey,
  botPrimaryTarget,
  type BotBackupSwitchParams
} from '../../shared/bots/bot-backup-models'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import type { HostUsageLimitCut } from '../native-chat/agent-session-wire/recovery/structured-agent-session-usage-limit-chain'
import type { BotUsageLimitKey } from './bot-usage-limit-gate'
import type {
  BotBackupSwitchResult,
  BotCutBackupState,
  BotFailoverSessionInfo,
  BotUsageLimitFailoverDeps
} from './bot-usage-limit-failover-execution'
import {
  readBackupsExhaustedState,
  readCurrentBotCut,
  resolveBotLaunchSetup,
  resolveBotUsageLimitKey,
  selectAndSwitchBotBackup,
  type BotLaunchSelection
} from './bot-backup-target-selection'
import {
  reconsiderReleasedLimit,
  returnBackupToPrimary,
  switchBackupManually,
  type BotBackupActions
} from './bot-usage-limit-failover-actions'

export type { BotCutBackupState, BotFailoverSessionInfo, BotUsageLimitFailoverDeps }

type ObservedCut = { cut: HostUsageLimitCut; key: BotUsageLimitKey; tracksDefault: boolean }

export class BotUsageLimitFailover {
  private readonly botQueues = new Map<string, Promise<void>>()
  private readonly cutStates = new Map<string, BotCutBackupState>()
  private readonly attemptedByCut = new Map<string, { turnItemId: string; targets: Set<string> }>()
  private readonly inFlightCuts = new Map<string, number | undefined>()
  private readonly pendingRechecks = new Set<string>()
  private readonly switchingCuts = new Set<string>()
  private readonly observedCuts = new Map<string, ObservedCut>()
  private readonly handledCuts = new Map<string, { turnItemId: string; superseded: boolean }>()
  private readonly pendingForcedReturns = new Set<string>()
  private readonly programmaticOptionSessions = new Set<string>()
  private readonly now: () => number
  private readonly actions: BotBackupActions

  constructor(private readonly deps: BotUsageLimitFailoverDeps) {
    this.now = deps.now ?? Date.now
    this.actions = {
      deps: this.deps,
      withProgrammaticOptions: (id, run) => this.withProgrammaticOptions(id, run),
      now: this.now
    }
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
    return this.switchingCuts.has(`${sessionId}:${turnItemId}`)
  }

  isSupersededCut(sessionId: string, turnItemId: string): boolean {
    const handled = this.handledCuts.get(sessionId)
    return handled?.turnItemId === turnItemId && handled.superseded
  }

  /** Resolves the setup a new bot session or automation run should launch with. */
  async resolveLaunchSetup(bot: Bot): Promise<BotLaunchSelection> {
    return runKeyedSerializedOperation(this.botQueues, bot.id, () =>
      resolveBotLaunchSetup(this.deps, bot, this.now())
    )
  }

  /** Called when a structured session observes a usage-limit cut. */
  async onUsageLimitCut(sessionId: string, cut: HostUsageLimitCut, recheck = false): Promise<void> {
    const bot = this.deps.botOfSession(sessionId)
    if (!bot || bot.paused || this.handledCuts.get(sessionId)?.turnItemId === cut.turnItemId) {
      return
    }
    const dedupeKey = `${sessionId}:${cut.turnItemId}`
    if (this.inFlightCuts.has(dedupeKey)) {
      if (recheck || this.inFlightCuts.get(dedupeKey) !== cut.resetsAt) {
        this.pendingRechecks.add(dedupeKey)
      }
      const observed = this.observedCuts.get(sessionId)
      if (
        !recheck &&
        observed?.cut.turnItemId === cut.turnItemId &&
        observed.cut.resetsAt !== cut.resetsAt
      ) {
        // Preserve the source account's deadline even if this switch consumes the cut.
        this.recordObservedCut(sessionId, { ...observed, cut })
      }
      return
    }
    const state = this.readCutBackupState(sessionId, cut.turnItemId)
    if (
      !recheck &&
      (state?.backupState === 'backups-exhausted' || state?.backupState === 'ask-backup') &&
      this.observedCuts.get(sessionId)?.cut.resetsAt === cut.resetsAt
    ) {
      return
    }
    this.inFlightCuts.set(dedupeKey, cut.resetsAt)
    const automatic = bot.backupModels?.automatic && bot.backupModels.order.length > 0
    if (automatic) {
      this.switchingCuts.add(dedupeKey)
    }
    const releaseWatch = automatic ? this.deps.holdTurnWatch?.(sessionId) : undefined
    try {
      await runKeyedSerializedOperation(this.botQueues, bot.id, async () => {
        await this.handleCutSerialized(bot.id, sessionId, cut)
      })
    } finally {
      this.inFlightCuts.delete(dedupeKey)
      this.switchingCuts.delete(dedupeKey)
      releaseWatch?.()
      if (this.pendingRechecks.delete(dedupeKey)) {
        const live = await this.deps.readSessionCut(sessionId)
        if (live?.turnItemId === cut.turnItemId) {
          await this.onUsageLimitCut(sessionId, live, true)
        }
      }
    }
  }

  switchSessionManually(params: BotBackupSwitchParams): Promise<BotBackupSwitchResult> {
    return runKeyedSerializedOperation(this.botQueues, params.botId, () =>
      switchBackupManually(this.actions, params, {
        isHandled: (id, turn) => this.handledCuts.get(id)?.turnItemId === turn,
        complete: (id, cut, superseded) => this.completeCut(id, cut, superseded),
        switching: this.switchingCuts
      })
    )
  }

  returnToPrimary(botId: string, options: { force?: boolean } = {}): Promise<boolean> {
    return runKeyedSerializedOperation(this.botQueues, botId, () =>
      returnBackupToPrimary(this.actions, botId, options.force === true, this.pendingForcedReturns)
    )
  }

  isReturnPending(botId: string): boolean {
    return this.pendingForcedReturns.has(botId)
  }

  /** Re-evaluates held sessions when a bot's backup config changes (e.g., automatic enabled). */
  async onBackupConfigChanged(botId: string): Promise<void> {
    const sessions = this.deps.listBotSessionIds?.(botId) ?? []
    for (const sessionId of sessions) {
      const cut = await this.deps.readSessionCut(sessionId)
      if (cut) {
        await this.onUsageLimitCut(sessionId, cut, true)
      }
    }
  }

  onLimitReleased(released: BotUsageLimitKey): Promise<void> {
    return reconsiderReleasedLimit(this.deps, released, {
      cuts: this.cutStates,
      observedKey: (id) => this.observedCuts.get(id)?.key,
      returnToPrimary: (id) => this.returnToPrimary(id),
      reconsider: (id, cut) => this.onUsageLimitCut(id, cut, true)
    })
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
    this.observedCuts.delete(sessionId)
    this.handledCuts.delete(sessionId)
    this.clearCutState(sessionId)
    this.attemptedByCut.delete(sessionId)
    const bot = this.deps.botOfSession(sessionId)
    if (bot?.activeBackup && bot.chatSessionId === sessionId) {
      if (this.pendingForcedReturns.has(bot.id)) {
        await this.returnToPrimary(bot.id, { force: true }).catch(() => {})
      } else {
        const primaryModel = bot.launch?.model ?? bot.activeBackup.primaryModel
        const primaryKey = await resolveBotUsageLimitKey(this.deps, {
          agent: bot.agent,
          model: primaryModel
        })
        if (!this.deps.gate.isLimited(primaryKey)) {
          await this.returnToPrimary(bot.id).catch(() => {})
        }
      }
    }
  }

  async onTurnInterrupted(sessionId: string): Promise<boolean> {
    const bot = this.deps.botOfSession(sessionId)
    if (bot?.chatSessionId === sessionId && this.pendingForcedReturns.has(bot.id)) {
      return this.returnToPrimary(bot.id, { force: true })
    }
    return false
  }

  private async handleCutSerialized(
    botId: string,
    sessionId: string,
    initialCut: HostUsageLimitCut
  ): Promise<void> {
    const bot = this.deps.listBots().find((entry) => entry.id === botId)
    const session = bot && !bot.paused ? await this.deps.getSessionInfo(sessionId) : null
    if (!bot || !session || this.handledCuts.get(sessionId)?.turnItemId === initialCut.turnItemId) {
      return
    }
    const accountHomeKey = await this.deps.resolveAccountHomeKey(session.provider, sessionId)
    const cut = await readCurrentBotCut(this.deps, session, initialCut)
    if (!cut) {
      return
    }
    const key = {
      agent: session.provider,
      accountHomeKey,
      model: session.model ?? ''
    }
    const observed = this.observedCuts.get(sessionId)
    if (
      observed?.cut.turnItemId !== cut.turnItemId ||
      observed.cut.resetsAt !== cut.resetsAt ||
      observed.key.accountHomeKey !== key.accountHomeKey ||
      observed.key.model !== key.model
    ) {
      const setup = bot.activeBackup?.target ?? botPrimaryTarget(bot)
      this.recordObservedCut(sessionId, {
        cut,
        key,
        tracksDefault: !!key.model && setup.agent === key.agent && !setup.model
      })
    } else if (!this.deps.gate.isLimited(key)) {
      this.clearCutState(sessionId)
      return
    }

    const previous = this.attemptedByCut.get(sessionId)
    const attempted = previous?.turnItemId === cut.turnItemId ? previous.targets : new Set<string>()
    attempted.add(botModelTargetKey(key))
    this.attemptedByCut.set(sessionId, { turnItemId: cut.turnItemId, targets: attempted })
    const result = await selectAndSwitchBotBackup(this.actions, {
      botId,
      session,
      cut,
      attempted,
      wasHomeChat: bot.chatSessionId === sessionId,
      onSwitching: () => {
        this.switchingCuts.add(`${sessionId}:${cut.turnItemId}`)
        this.setCutState(sessionId, { turnItemId: cut.turnItemId, backupState: 'switching' })
      }
    })
    if (result.state === 'switched') {
      this.completeCut(sessionId, cut, result.superseded)
    } else if (result.state === 'backups-exhausted') {
      this.setCutState(sessionId, await readBackupsExhaustedState(this.deps, result.bot, cut))
    } else if (result.state === 'ask-backup') {
      this.setCutState(sessionId, { turnItemId: cut.turnItemId, backupState: 'ask-backup' })
    } else {
      this.clearCutState(sessionId)
    }
  }

  private recordObservedCut(sessionId: string, observed: ObservedCut): void {
    const { cut, key, tracksDefault } = observed
    this.observedCuts.set(sessionId, observed)
    this.deps.gate.recordLimit({ ...key, resetsAt: cut.resetsAt })
    if (tracksDefault) {
      this.deps.gate.recordLimit({
        ...key,
        model: '',
        observedModel: key.model,
        resetsAt: cut.resetsAt
      })
    }
  }

  private completeCut(sessionId: string, cut: HostUsageLimitCut, superseded: boolean): void {
    this.handledCuts.set(sessionId, { turnItemId: cut.turnItemId, superseded })
    this.observedCuts.delete(sessionId)
    this.attemptedByCut.delete(sessionId)
    this.clearCutState(sessionId)
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
