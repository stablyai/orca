import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../../persistence/loading-store/store'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'
import {
  resolveClaudeAccountRotationSettings,
  type ClaudeAccountRotationPause,
  type ClaudeAccountRotationStatus
} from '../../../shared/agent-accounts/claude/claude-account-rotation'
import { claudeKeychainService } from '../runtime-auth/keychain'
import { claudeStateFile } from '../sign-in/claude-account-folder'
import { getSelectedClaudeAccountIdForTarget } from '../selection/runtime-selection'
import { claudeAccountLabel, swappedAccountRecords } from './claude-rotation-account-records'
import { fetchClaudeAccountOfToken, fetchRotationUsage } from './claude-rotation-api'
import type { RotationCheckDeps } from './claude-rotation-candidates'
import { checkRotationFolder, type RotationCheckResult } from './claude-rotation-check'
import { createMacKeychainSlotStore } from './claude-rotation-keychain'
import type { RotationFolder } from './claude-rotation-login-meta'
import { ROTATION_TIMING } from './claude-rotation-policy'
import { readClaudeSessionsByHome } from './claude-rotation-sessions'
import { RotationStateFiles, type RotationJournal } from './claude-rotation-state-files'
import {
  buildRotationStatus,
  snapshotRotationFolders,
  type RotationFolderSnapshot
} from './claude-rotation-status'
import { recoverInterruptedSwap } from './claude-rotation-swap'
import { verifySwap, type RotationVerifyOutcome } from './claude-rotation-verify'
import { rotationNotice, type RotationNotice } from './claude-rotation-notices'

export type ClaudeAccountRotationServiceOptions = {
  store: Pick<Store, 'getSettings' | 'updateSettings'>
  router: {
    accountHome: (accountId: string) => string
    coveredBySystemDefault: (accountId: string) => boolean
    readonly userHome: string
  }
  rateLimits?: Pick<RateLimitService, 'evictInactiveClaudeCache' | 'refreshForClaudeAccountChange'>
  dataRoot: string
  notify: (notice: RotationNotice) => void
  platform?: NodeJS.Platform
  deps?: Partial<RotationCheckDeps>
}

/** Swaps Claude logins between account folders near their limits; desktop main only. */
export class ClaudeAccountRotationService {
  readonly files: RotationStateFiles
  private readonly deps: RotationCheckDeps
  private readonly profilesRoot: string
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
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
      onMetaSwapped: (a, b) => this.swapAccountRecords(a, b)
    }
  }

  start(): void {
    if (this.timer || this.platform() !== 'darwin') {
      return
    }
    // Its own timer: usage polling pauses with the window, but limits are reached in the background.
    this.timer = setInterval(() => void this.runCycle(), ROTATION_TIMING.cycleMs)
    this.timer.unref?.()
    setTimeout(() => void this.runCycle(), 5_000).unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  runCycle(): Promise<void> {
    this.running ??= this.cycle()
      .catch((error: unknown) => {
        this.files.log('cycle_failed', { error: error instanceof Error ? error.name : 'unknown' })
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  externalRotatorActive(): boolean {
    const dir = join(this.options.router.userHome, '.claude', 'rotate')
    return existsSync(join(dir, 'enabled')) || existsSync(join(dir, 'journal.json'))
  }

  getStatus(): ClaudeAccountRotationStatus {
    const settings = this.options.store.getSettings()
    const rotation = resolveClaudeAccountRotationSettings(settings)
    const folders = this.folders()
    return buildRotationStatus({
      rotation,
      supported: this.platform() === 'darwin',
      externalRotatorActive: this.externalRotatorActive(),
      pause: this.pauseReason(folders),
      folders,
      selectedAccountId: getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' }),
      label: (id) => claudeAccountLabel(settings, id),
      snapshot: this.snapshot,
      state: this.files.loadState(),
      pendingSwitch: this.files.loadJournal() !== null,
      now: this.deps.now()
    })
  }

  private platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform
  }

  private pauseReason(folders: RotationFolder[]): ClaudeAccountRotationPause {
    if (this.platform() !== 'darwin') {
      return 'unsupported-platform'
    }
    if (!resolveClaudeAccountRotationSettings(this.options.store.getSettings()).enabled) {
      return 'off'
    }
    if (this.externalRotatorActive()) {
      return 'external-rotator'
    }
    return folders.length < 2 ? 'no-accounts' : null
  }

  /** Host account folders with their own login; WSL and System default ones are left alone. */
  private folders(): RotationFolder[] {
    const { router } = this.options
    const folders: RotationFolder[] = []
    for (const account of this.options.store.getSettings().claudeManagedAccounts) {
      if (account.managedAuthRuntime === 'wsl') {
        continue
      }
      try {
        if (router.coveredBySystemDefault(account.id)) {
          continue
        }
        const home = router.accountHome(account.id)
        folders.push({
          accountId: account.id,
          home,
          service: claudeKeychainService(home),
          stateFile: claudeStateFile(home, router.userHome)
        })
      } catch {
        // An unreadable folder cannot take part in a swap.
      }
    }
    return folders
  }

  private async cycle(): Promise<void> {
    if (this.platform() !== 'darwin' || this.externalRotatorActive()) {
      return
    }
    const folders = this.folders()
    const byId = new Map(folders.map((folder) => [folder.accountId, folder]))
    // A swap in flight is finished or checked even after the feature is turned off.
    if (this.files.loadJournal()) {
      const recovered = await recoverInterruptedSwap(byId, this.deps)
      if (recovered) {
        this.files.log('recover_cycle', { result: recovered })
      }
      const verified = await verifySwap(byId, this.deps)
      if (verified) {
        this.afterVerify(verified.outcome, verified.journal)
      }
      if (this.files.loadJournal()) {
        return
      }
    }
    if (this.pauseReason(folders) !== null) {
      return
    }
    const settings = this.options.store.getSettings()
    const rotation = resolveClaudeAccountRotationSettings(settings)
    const labels = new Map(
      folders.map((f) => [f.accountId, claudeAccountLabel(settings, f.accountId)])
    )
    const state = this.files.loadState()
    const sessions = await this.deps.readSessions()
    const selectedId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
    const targets = folders.filter(
      (folder) => folder.accountId === selectedId || (sessions?.get(folder.home) ?? 0) > 0
    )
    for (const target of targets) {
      const result = await checkRotationFolder({
        target,
        folders,
        sessions,
        state,
        settings: rotation,
        deps: this.deps
      })
      if (result?.note === 'swapped' && 'journal' in result) {
        this.afterSwap(result, labels, state)
        break
      }
      if (result && 'alert' in result && result.alert) {
        this.options.notify(rotationNotice({ type: 'no-candidate', limits: result.over }))
      }
    }
    state.lastCheckedAt = this.deps.now()
    this.snapshot = await snapshotRotationFolders(folders, sessions, state, this.deps)
    this.files.saveState(state)
  }

  private afterSwap(
    result: Extract<RotationCheckResult, { note: 'swapped' }>,
    labels: Map<string, string | null>,
    state: ReturnType<RotationStateFiles['loadState']>
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
    if (outcome === 'reverted') {
      this.refreshUsage(journal)
    }
    if (outcome === 'reverted' || outcome === 'revert_failed' || outcome === 'unexpected_account') {
      this.options.notify(rotationNotice({ type: outcome }))
    }
  }

  private swapAccountRecords(a: string, b: string): void {
    const patch = swappedAccountRecords(this.options.store.getSettings(), a, b)
    if (patch) {
      this.options.store.updateSettings(patch, { notifyListeners: true })
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
