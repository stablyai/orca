import { app, BrowserWindow, ipcMain } from 'electron'
import { STAR_NAG_INITIAL_THRESHOLD } from '../../shared/constants'
import { checkOrcaStarred, starOrca } from '../github/client'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import { track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import {
  bucketStarNagAgentsSinceBaseline,
  type StarNagOutcome,
  type StarNagPromptMode,
  type StarNagPromptSource
} from '../../shared/star-nag-telemetry'
import {
  type StarNagPromptContext,
  type StarNagPromptSession,
  trackStarNagSessionOutcome
} from './prompt-session-telemetry'

const STAR_NAG_COOLDOWN_DAYS = 3
const STAR_NAG_COOLDOWN_MS = STAR_NAG_COOLDOWN_DAYS * 24 * 60 * 60 * 1000

/**
 * Service that decides when to prompt the user with the "star Orca on GitHub"
 * notification. Counts agents spawned since the current app version was first
 * seen; crosses a doubling threshold (default 35 → 70 → 140 …) to fire the
 * renderer notification via 'star-nag:show'.
 *
 * State lives in PersistedUIState so it survives restarts alongside the rest
 * of the UI preferences (dismissed update versions, etc).
 */
export class StarNagService {
  private store: Store
  private stats: StatsCollector
  private disposeStatsListener: (() => void) | null = null
  // Why: once we broadcast the card, the renderer owns the UI until the user
  // dismisses or stars. Without this in-memory guard, every subsequent
  // agent_start past the threshold would re-enter maybeShow() and spawn a new
  // `gh api` subprocess on each spawn — cheap individually, but a power user
  // at 40 agents with threshold 35 would fork gh on every spawn until they
  // act on the card.
  private promptVisible = false
  // Why: prevent concurrent gh invocations if agents spawn rapidly during the
  // tiny window between crossing the threshold and the first gh check
  // resolving.
  private evaluating = false
  private pendingForceShow = false
  // Why: dismissal backoff and action telemetry must use the prompt context
  // that was delivered, not whatever threshold/source happens to be current
  // when the renderer later reports a user action.
  private promptSession: StarNagPromptSession | null = null

  constructor(store: Store, stats: StatsCollector) {
    this.store = store
    this.stats = stats
  }

  start(): void {
    // Why: capture the baseline eagerly on first boot after an update so the
    // "agents since update" counter doesn't include pre-update spawns. We do
    // this here instead of waiting for the next agent_start so that a brand
    // new install with a pre-existing stats file (unusual, but possible via
    // copy of userData) starts from a sensible baseline.
    this.ensureBaseline()
    this.disposeStatsListener = this.stats.onAgentStarted((total) => {
      this.handleAgentSpawned(total)
    })
  }

  stop(): void {
    this.disposeStatsListener?.()
    this.disposeStatsListener = null
  }

  registerIpcHandlers(): void {
    ipcMain.handle('star-nag:dismiss', () => this.dismiss())
    ipcMain.handle('star-nag:later', () => this.defer('later'))
    ipcMain.handle('star-nag:complete', () => this.markCompleted())
    ipcMain.handle('star-nag:disable', () => this.disable())
    ipcMain.handle('star-nag:openWeb', () => this.openWeb())
    ipcMain.handle('star-nag:starOrca', () => this.starOrcaFromNag())
    ipcMain.handle('star-nag:forceShow', () => this.forceShow())
  }

  // ── State helpers ─────────────────────────────────────────────────

  private ensureBaseline(): void {
    const ui = this.store.getUI()
    const currentVersion = app.getVersion()
    if (ui.starNagAppVersion === currentVersion && ui.starNagBaselineAgents != null) {
      return
    }
    // Why: reset both the baseline and the threshold so the user gets a fresh
    // nag countdown after each update. Past dismissal state is intentionally
    // discarded — shipping new value is the whole reason we bother asking
    // again. `starNagCompleted` is preserved so we never re-ask someone who
    // already starred.
    this.store.updateUI({
      starNagAppVersion: currentVersion,
      starNagBaselineAgents: this.stats.getTotalAgentsSpawned(),
      starNagNextThreshold: STAR_NAG_INITIAL_THRESHOLD
    })
  }

  private handleAgentSpawned(total: number): void {
    if (this.promptVisible || this.evaluating) {
      return
    }
    const ui = this.store.getUI()
    if (ui.starNagCompleted) {
      return
    }
    if (this.isCooldownActive(ui.starNagDeferredUntil)) {
      return
    }
    // Guard against drift: if the version changed since last boot but we
    // haven't rehydrated yet (e.g. in-process update on Linux AppImage), fix
    // the baseline before evaluating the threshold so we don't instantly fire.
    const currentVersion = app.getVersion()
    if (ui.starNagAppVersion !== currentVersion) {
      this.ensureBaseline()
      return
    }
    const baseline = ui.starNagBaselineAgents ?? total
    const threshold = ui.starNagNextThreshold ?? STAR_NAG_INITIAL_THRESHOLD
    const sinceBaseline = total - baseline
    if (sinceBaseline < threshold) {
      return
    }
    void this.maybeShow('threshold')
  }

  private async maybeShow(source: StarNagPromptSource): Promise<void> {
    if (this.promptVisible || this.evaluating) {
      return
    }
    this.evaluating = true
    try {
      // Why: checkOrcaStarred lets us skip users who already starred outside
      // the app. When gh cannot tell us, keep the prompt available but route
      // the renderer to the browser fallback instead of a dead direct-star
      // button.
      const starred = await checkOrcaStarred()
      if (this.store.getUI().starNagCompleted) {
        this.pendingForceShow = false
        return
      }
      if (starred === null) {
        this.broadcastShow(source, 'web')
        return
      }
      if (starred) {
        this.trackAlreadyStarredSuppressed(source)
        // Already starred somewhere — lock in the permanent suppression so we
        // stop recomputing thresholds on every spawn.
        this.markCompleted()
        return
      }
      if (this.promptVisible) {
        return
      }
      this.broadcastShow(source, 'gh')
    } finally {
      this.evaluating = false
      this.flushPendingForceShow()
    }
  }

  private flushPendingForceShow(): void {
    if (!this.pendingForceShow || this.evaluating) {
      return
    }
    this.pendingForceShow = false
    if (this.promptVisible) {
      return
    }
    this.broadcastShow('force_show', 'gh')
  }

  private broadcastShow(source: StarNagPromptSource, mode: StarNagPromptMode): boolean {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) {
      this.promptVisible = false
      this.promptSession = null
      return false
    }
    const context = this.createPromptContext(source, mode)
    win.webContents.send('star-nag:show', { mode })
    this.promptVisible = true
    this.promptSession = context
    this.trackOutcome('shown')
    this.logConsoleEvent('star_nag_shown', source)
    return true
  }

  private createPromptContext(
    source: StarNagPromptSource,
    mode: StarNagPromptMode
  ): StarNagPromptContext {
    const ui = this.store.getUI()
    const threshold = ui.starNagNextThreshold ?? STAR_NAG_INITIAL_THRESHOLD
    const agentsSinceBaseline = Math.max(
      0,
      this.stats.getTotalAgentsSpawned() - (ui.starNagBaselineAgents ?? 0)
    )
    return {
      source,
      mode,
      threshold,
      agents_since_baseline: agentsSinceBaseline,
      agents_since_baseline_bucket: bucketStarNagAgentsSinceBaseline(agentsSinceBaseline),
      ...getCohortAtEmit()
    }
  }

  private trackOutcome(
    outcome: StarNagOutcome,
    options: { mode?: StarNagPromptMode; nextThreshold?: number; cooldownDays?: number } = {}
  ): void {
    const session = this.promptSession
    if (!session) {
      return
    }
    trackStarNagSessionOutcome(session, outcome, options)
  }

  private trackAlreadyStarredSuppressed(source: StarNagPromptSource): void {
    track('star_nag_outcome', {
      ...this.createPromptContext(source, 'gh'),
      outcome: 'already_starred_suppressed'
    })
  }

  private logConsoleEvent(
    event: 'star_nag_shown' | 'star_nag_dismissed' | 'star_nag_later',
    source: StarNagPromptSource,
    nextThreshold?: number
  ): void {
    const ui = this.store.getUI()
    const threshold = ui.starNagNextThreshold ?? STAR_NAG_INITIAL_THRESHOLD
    const agentsSinceBaseline = this.stats.getTotalAgentsSpawned() - (ui.starNagBaselineAgents ?? 0)

    console.info({
      event,
      app_version: app.getVersion(),
      threshold,
      agents_since_baseline: agentsSinceBaseline,
      source,
      ...(nextThreshold === undefined ? {} : { next_threshold: nextThreshold })
    })
  }

  // ── Public actions (invoked from IPC) ─────────────────────────────

  /**
   * User closed the notification without starring → defer threshold prompts
   * for a substantial cross-version cooldown. We still maintain the legacy
   * threshold fields so historical dashboards and old builds remain coherent.
   */
  private dismiss(): void {
    this.defer('dismissed')
  }

  private defer(outcome: Extract<StarNagOutcome, 'dismissed' | 'later'>): void {
    const session = this.promptSession
    if (!session) {
      this.promptVisible = false
      return
    }
    const ui = this.store.getUI()
    const threshold = ui.starNagNextThreshold ?? STAR_NAG_INITIAL_THRESHOLD
    const nextThreshold = threshold * 2
    this.trackOutcome(outcome, { nextThreshold, cooldownDays: STAR_NAG_COOLDOWN_DAYS })
    this.logConsoleEvent(
      outcome === 'later' ? 'star_nag_later' : 'star_nag_dismissed',
      session.source,
      nextThreshold
    )
    this.store.updateUI({
      starNagNextThreshold: nextThreshold,
      starNagBaselineAgents: this.stats.getTotalAgentsSpawned(),
      starNagDeferredUntil: Date.now() + STAR_NAG_COOLDOWN_MS
    })
    this.promptVisible = false
    this.promptSession = null
  }

  private disable(): void {
    this.trackOutcome('disabled')
    this.markCompleted()
  }

  private openWeb(): void {
    const session = this.promptSession
    if (!session || session.openedRepoTracked) {
      return
    }
    session.openedRepoTracked = true
    trackStarNagSessionOutcome(session, 'opened_repo', { mode: 'web' })
    this.markCompleted()
  }

  private async starOrcaFromNag(): Promise<boolean> {
    const session = this.promptSession
    if (!session) {
      return false
    }
    if (session.starAttemptPromise) {
      return session.starAttemptPromise
    }
    const attempt = this.runStarOrcaAttempt(session)
    session.starAttemptPromise = attempt
    try {
      return await attempt
    } finally {
      if (this.promptSession === session) {
        delete session.starAttemptPromise
      }
    }
  }

  private async runStarOrcaAttempt(session: StarNagPromptSession): Promise<boolean> {
    trackStarNagSessionOutcome(session, 'star_clicked', { mode: 'gh' })
    const starred = await starOrca()
    if (!starred) {
      trackStarNagSessionOutcome(session, 'direct_star_failed', { mode: 'gh' })
      if (this.promptSession === session) {
        session.mode = 'web'
      }
      return false
    }
    trackStarNagSessionOutcome(session, 'direct_star_succeeded', { mode: 'gh' })
    // Why: app_starred_orca remains the canonical cross-surface success event;
    // star_nag_outcome is only the nag-funnel companion.
    track('app_starred_orca', {
      source: 'star_nag',
      ...getCohortAtEmit()
    })
    this.markCompleted()
    return true
  }

  /** User successfully starred or opted out → never nag again. */
  private markCompleted(): void {
    this.store.updateUI({ starNagCompleted: true, starNagDeferredUntil: null })
    this.promptVisible = false
    this.promptSession = null
    this.pendingForceShow = false
  }

  private isCooldownActive(deferredUntil: number | null | undefined): boolean {
    return typeof deferredUntil === 'number' && deferredUntil > Date.now()
  }

  /** Dev-only entry point: skip all gating and fire the notification. */
  private forceShow(): void {
    if (this.promptVisible) {
      return
    }
    if (this.evaluating) {
      this.pendingForceShow = true
      return
    }
    this.broadcastShow('force_show', 'gh')
  }
}
