import { join } from 'node:path'
import type { Store } from '../../persistence/loading-store/store'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'
import {
  resolveClaudeAccountRotationSettings,
  type ClaudeAccountRotationPause,
  type ClaudeAccountRotationStatus
} from '../../../shared/agent-accounts/claude/claude-account-rotation'
import { getSelectedClaudeAccountIdForTarget } from '../selection/runtime-selection'
import { claudeAccountLabel, rotationAccountRecords } from './claude-rotation-account-records'
import { fetchClaudeAccountOfToken, fetchRotationUsage } from './claude-rotation-api'
import type { RotationCheckDeps } from './claude-rotation-candidates'
import {
  externalRotatorActive,
  listRotationFolders,
  type RotationRouter
} from './claude-rotation-folders'
import { checkRotationFolder, type RotationCheckResult } from './claude-rotation-check'
import { createMacKeychainSlotStore } from './claude-rotation-keychain'
import type { RotationFolder } from './claude-rotation-login-meta'
import { ROTATION_TIMING } from './claude-rotation-policy'
import { RotationTimer } from './claude-rotation-timer'
import { readClaudeSessionsByHome } from './claude-rotation-sessions'
import {
  RotationStateFiles,
  type RotationJournal,
  type RotationState
} from './claude-rotation-state-files'
import {
  buildRotationStatus,
  snapshotRotationFolders,
  type RotationFolderSnapshot
} from './claude-rotation-status'
import { recoverInterruptedSwap } from './claude-rotation-recover'
import { verifySwap, type RotationVerifyOutcome } from './claude-rotation-verify'
import { rotationNotice, type RotationNotice } from './claude-rotation-notices'

export type ClaudeAccountRotationServiceOptions = {
  store: Pick<Store, 'getSettings' | 'updateSettingsAndFlush' | 'onSettingsChanged'>
  router: RotationRouter
  rateLimits?: Pick<RateLimitService, 'evictInactiveClaudeCache' | 'refreshForClaudeAccountChange'>
  dataRoot: string
  notify: (notice: RotationNotice) => void
  platform?: NodeJS.Platform
  deps?: Partial<RotationCheckDeps>
}

// A settings change is often several saves in a row; act once they settle.
const SETTINGS_SETTLE_MS = 2_000

/** Swaps Claude logins between account folders near their limits; desktop main only. */
export class ClaudeAccountRotationService {
  readonly files: RotationStateFiles
  private readonly deps: RotationCheckDeps
  private readonly profilesRoot: string
  private readonly timer: RotationTimer
  private running: Promise<number | null> | null = null
  private settingsKey: string | null = null
  private idleDelayMs: number = ROTATION_TIMING.cycleMs
  private unsubscribe: (() => void) | null = null
  private snapshot = new Map<string, RotationFolderSnapshot>()

  constructor(private readonly options: ClaudeAccountRotationServiceOptions) {
    this.files = new RotationStateFiles(join(options.dataRoot, 'claude-account-rotation'))
    this.profilesRoot = join(options.dataRoot, 'claude-profiles')
    this.deps = {
      slots: createMacKeychainSlotStore(),
      files: this.files,
      whoami: fetchClaudeAccountOfToken,
      fetchUsage: fetchRotationUsage,
      readSessions: () => readClaudeSessionsByHome(this.profilesRoot),
      now: Date.now,
      ...options.deps,
      records: rotationAccountRecords(options.store)
    }
    this.timer = new RotationTimer(() => this.runCycle(), SETTINGS_SETTLE_MS)
  }

  start(): void {
    if (this.settingsKey !== null || this.platform() !== 'darwin') {
      return
    }
    this.settingsKey = this.rotationSettingsKey()
    this.unsubscribe = this.options.store.onSettingsChanged(() => this.settingsChanged())
    // The first look also finishes a swap cut off by a quit, even with the feature off.
    this.timer.start(5_000)
  }

  stop(): void {
    this.settingsKey = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.timer.stop()
  }

  /** Resolves with the delay before the next cycle, or null when there is nothing to watch. */
  runCycle(): Promise<number | null> {
    this.running ??= this.cycle()
      .catch((error: unknown) => {
        this.files.log('cycle_failed', { error: error instanceof Error ? error.name : 'unknown' })
        return ROTATION_TIMING.cycleMs
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  private rotationSettingsKey(): string {
    const settings = this.options.store.getSettings()
    return `${JSON.stringify(settings.claudeAccountRotation ?? null)}\0${settings.claudeManagedAccounts.length}`
  }

  private settingsChanged(): void {
    const key = this.rotationSettingsKey()
    if (this.settingsKey === null || key === this.settingsKey) {
      return
    }
    this.settingsKey = key
    this.idleDelayMs = ROTATION_TIMING.cycleMs
    this.timer.poke()
  }

  async getStatus(): Promise<ClaudeAccountRotationStatus> {
    const settings = this.options.store.getSettings()
    const rotation = resolveClaudeAccountRotationSettings(settings)
    const external = await externalRotatorActive(this.options.router.userHome)
    const folders = await this.folders()
    return buildRotationStatus({
      rotation,
      supported: this.platform() === 'darwin',
      externalRotatorActive: external,
      pause: this.pauseReason(folders, external),
      folders,
      selectedAccountId: getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' }),
      label: (id) => claudeAccountLabel(settings, id),
      snapshot: this.snapshot,
      state: await this.files.loadState(),
      pendingSwitch: await this.files.journalExists(),
      switchNeedsRepair: (await this.files.loadJournal())?.needsRepair === true,
      now: this.deps.now()
    })
  }

  private platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform
  }

  private pauseReason(folders: RotationFolder[], external: boolean): ClaudeAccountRotationPause {
    if (this.platform() !== 'darwin') {
      return 'unsupported-platform'
    }
    if (!resolveClaudeAccountRotationSettings(this.options.store.getSettings()).enabled) {
      return 'off'
    }
    if (external) {
      return 'external-rotator'
    }
    return folders.length < 2 ? 'no-accounts' : null
  }

  private folders(): Promise<RotationFolder[]> {
    return listRotationFolders(
      this.options.store.getSettings().claudeManagedAccounts,
      this.options.router
    )
  }

  private async cycle(): Promise<number | null> {
    if (this.platform() !== 'darwin') {
      return null
    }
    const enabled = resolveClaudeAccountRotationSettings(this.options.store.getSettings()).enabled
    if (await externalRotatorActive(this.options.router.userHome)) {
      // Nothing says when the other tool stops, so look again now and then while the setting is on.
      return enabled ? ROTATION_TIMING.idleMaxMs : null
    }
    // A swap in flight is finished or checked even after the feature is turned off.
    if (await this.files.journalExists()) {
      // Recovery reports a folder left with no login or a third account once, as the check does.
      if ((await recoverInterruptedSwap(this.deps)) === 'needs_repair') {
        this.options.notify(rotationNotice({ type: 'needs_repair' }))
      }
      const verified = await verifySwap(this.deps)
      if (verified) {
        this.afterVerify(verified.outcome, verified.journal)
      }
      if (await this.files.journalExists()) {
        const pending = await this.files.loadJournal()
        if (!pending) {
          // Its backups may hold the only copy of a login, so it blocks swaps until removed.
          this.files.log('journal_unreadable')
        }
        // Only the user can repair the folders, so look less often meanwhile.
        return pending?.needsRepair ? ROTATION_TIMING.idleMaxMs : ROTATION_TIMING.cycleMs
      }
    }
    const folders = await this.folders()
    if (this.pauseReason(folders, false) !== null) {
      return null
    }
    const settings = this.options.store.getSettings()
    const rotation = resolveClaudeAccountRotationSettings(settings)
    const labels = new Map(
      folders.map((f) => [f.accountId, claudeAccountLabel(settings, f.accountId)])
    )
    const state = await this.files.loadState()
    const sessions = await this.deps.readSessions()
    const selectedId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
    const targets = folders.filter(
      (folder) => folder.accountId === selectedId || (sessions?.get(folder.home) ?? 0) > 0
    )
    let swapped = false
    for (const target of targets) {
      const result = await checkRotationFolder({
        target,
        folders,
        sessions,
        state,
        settings: rotation,
        deps: this.deps,
        currentSettings: async () => {
          const current = resolveClaudeAccountRotationSettings(this.options.store.getSettings())
          const allowed =
            current.enabled && !(await externalRotatorActive(this.options.router.userHome))
          return allowed ? current : null
        }
      })
      if (result?.note === 'swapped' && 'journal' in result) {
        this.afterSwap(result, labels, state)
        swapped = true
        break
      }
      if (result && 'alert' in result && result.alert) {
        this.options.notify(rotationNotice({ type: 'no-candidate', limits: result.over }))
      }
    }
    state.lastCheckedAt = this.deps.now()
    this.snapshot = await snapshotRotationFolders(folders, sessions, state, this.deps)
    await this.files.saveState(state)
    const busy = sessions === null || folders.some((f) => (sessions.get(f.home) ?? 0) > 0)
    if (swapped || busy) {
      this.idleDelayMs = ROTATION_TIMING.cycleMs
      return ROTATION_TIMING.cycleMs
    }
    // No Claude session runs in any account folder, so none can reach a limit: look less often.
    this.idleDelayMs = Math.min(this.idleDelayMs * 2, ROTATION_TIMING.idleMaxMs)
    return this.idleDelayMs
  }

  private afterSwap(
    result: Extract<RotationCheckResult, { note: 'swapped' }>,
    labels: Map<string, string | null>,
    state: RotationState
  ): void {
    const { journal } = result
    const fromLabel = labels.get(journal.a) ?? null
    const toLabel = labels.get(journal.b) ?? null
    state.lastSwitch = {
      at: journal.at,
      accountId: journal.a,
      fromClaudeAccount: journal.fromAccount,
      toClaudeAccount: journal.toAccount,
      fromLabel,
      toLabel,
      kind: result.kind,
      limits: result.over
    }
    this.refreshUsage(journal)
    this.options.notify(
      rotationNotice({
        type: 'switched',
        kind: result.kind,
        limits: result.over,
        fromLabel,
        toLabel
      })
    )
  }

  private afterVerify(outcome: RotationVerifyOutcome, journal: RotationJournal): void {
    // A recovered swap reaches 'ok' here without passing afterSwap, so refresh after either.
    if (outcome === 'ok' || outcome === 'reverted') {
      this.refreshUsage(journal)
    }
    if (outcome === 'reverted' || outcome === 'needs_repair') {
      this.options.notify(rotationNotice({ type: outcome }))
    }
  }

  private refreshUsage(journal: RotationJournal): void {
    const rateLimits = this.options.rateLimits
    if (!rateLimits) {
      return
    }
    rateLimits.evictInactiveClaudeCache(journal.a)
    rateLimits.evictInactiveClaudeCache(journal.b)
    void rateLimits.refreshForClaudeAccountChange(undefined, { runtime: 'host' }).catch(() => {})
  }
}
