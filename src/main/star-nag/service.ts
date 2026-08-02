import { BrowserWindow, ipcMain } from 'electron'
import { STAR_NAG_INITIAL_THRESHOLD } from '../../shared/constants'
import { checkOrcaStarred } from '../github/client'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import { track } from '../telemetry/client'
import type {
  StarNagOutcome,
  StarNagPromptMode,
  StarNagPromptSource
} from '../../shared/star-nag-telemetry'
import { type StarNagPromptSession, trackStarNagSessionOutcome } from './prompt-session-telemetry'
import { createStarNagPromptContext } from './prompt-context'
import { logStarNagConsoleEvent } from './console-events'
import { StarNagAgentValueMoment, type AgentValueMomentPreparation } from './agent-value-moment'
import { deferAfterStarNagWebHandoff } from './web-handoff'
import { runStarNagDirectStarAttempt } from './direct-star-attempt'
import { handleStarNagOnboardingCompleted } from './onboarding-completed'
import { ensureStarNagBaseline, shouldShowStarNagThresholdPrompt } from './threshold-trigger'

const STAR_NAG_COOLDOWN_DAYS = 3
const STAR_NAG_COOLDOWN_MS = STAR_NAG_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
type StarNagSurface = 'card' | 'toast'

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
  private pendingOnboardingCompleted = false
  // Why: dismissal backoff and action telemetry must use the prompt context
  // that was delivered, not whatever threshold/source happens to be current
  // when the renderer later reports a user action.
  private promptSession: StarNagPromptSession | null = null
  private agentValueMoment: StarNagAgentValueMoment

  constructor(store: Store, stats: StatsCollector) {
    this.store = store
    this.stats = stats
    this.agentValueMoment = new StarNagAgentValueMoment({
      store,
      isEvaluating: () => this.evaluating,
      setEvaluating: (value) => {
        this.setEvaluating(value)
      },
      isPromptVisible: () => this.promptVisible,
      isCooldownActive: (deferredUntil) => this.isCooldownActive(deferredUntil),
      markCompleted: () => this.markCompleted(),
      trackAlreadyStarredSuppressed: () => this.trackAlreadyStarredSuppressed('agent_value_moment'),
      broadcastShow: (mode) => this.broadcastShow('agent_value_moment', mode)
    })
  }

  start(): void {
    ensureStarNagBaseline(this.store, this.stats)
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
    ipcMain.handle('star-nag:agentValueMoment', () => this.prepareAgentValueMoment())
    ipcMain.handle('star-nag:showAgentValueMoment', () => this.showPreparedAgentValueMoment())
    ipcMain.handle('star-nag:onboardingCompleted', () => this.onboardingCompleted())
  }

  // ── State helpers ─────────────────────────────────────────────────

  private handleAgentSpawned(total: number): void {
    if (
      !shouldShowStarNagThresholdPrompt({
        store: this.store,
        stats: this.stats,
        total,
        promptVisible: this.promptVisible,
        evaluating: this.evaluating,
        isCooldownActive: (deferredUntil) => this.isCooldownActive(deferredUntil)
      })
    ) {
      return
    }
    void this.maybeShow('threshold')
  }

  private async maybeShow(
    source: StarNagPromptSource,
    surface: StarNagSurface = 'card'
  ): Promise<boolean> {
    if (this.promptVisible || this.evaluating) {
      return false
    }
    this.setEvaluating(true)
    try {
      // Why: checkOrcaStarred lets us skip users who already starred outside
      // the app. When gh cannot tell us, keep the prompt available but route
      // the renderer to the browser fallback instead of a dead direct-star
      // button.
      const starred = await checkOrcaStarred()
      if (this.store.getUI().starNagCompleted) {
        this.pendingForceShow = false
        return false
      }
      if (starred === null) {
        return this.broadcastShow(source, 'web', surface)
      }
      if (starred) {
        this.trackAlreadyStarredSuppressed(source)
        // Already starred somewhere — lock in the permanent suppression so we
        // stop recomputing thresholds on every spawn.
        this.markCompleted()
        return false
      }
      if (this.promptVisible) {
        return false
      }
      return this.broadcastShow(source, 'gh', surface)
    } finally {
      this.setEvaluating(false)
      this.flushPendingForceShow()
    }
  }

  private setEvaluating(value: boolean): void {
    this.evaluating = value
    if (!value) {
      this.flushPendingOnboardingCompleted()
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

  private flushPendingOnboardingCompleted(): void {
    if (!this.pendingOnboardingCompleted || this.evaluating) {
      return
    }
    this.pendingOnboardingCompleted = false
    void this.onboardingCompleted()
  }

  private broadcastShow(
    source: StarNagPromptSource,
    mode: StarNagPromptMode,
    surface: StarNagSurface = 'card'
  ): boolean {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) {
      this.promptVisible = false
      this.promptSession = null
      return false
    }
    const context = createStarNagPromptContext(this.store, this.stats, source, mode)
    win.webContents.send('star-nag:show', { mode, surface })
    this.promptVisible = true
    this.promptSession = context
    this.trackOutcome('shown')
    logStarNagConsoleEvent(this.store, this.stats, 'star_nag_shown', source)
    return true
  }

  private broadcastHide(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('star-nag:hide')
      }
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
      ...createStarNagPromptContext(this.store, this.stats, source, 'gh'),
      outcome: 'already_starred_suppressed'
    })
  }

  // ── Public actions (invoked from IPC) ─────────────────────────────

  private async prepareAgentValueMoment(): Promise<AgentValueMomentPreparation> {
    return this.agentValueMoment.prepare()
  }

  private showPreparedAgentValueMoment(): void {
    // Why: renderer re-confirms "not typing / no active agent" after the slow
    // gh check before invoking this show step.
    this.agentValueMoment.showPrepared()
  }

  private async onboardingCompleted(): Promise<void> {
    await handleStarNagOnboardingCompleted({
      store: this.store,
      isCooldownActive: (deferredUntil) => this.isCooldownActive(deferredUntil),
      isEvaluating: () => this.evaluating,
      queueAfterEvaluation: () => {
        this.pendingOnboardingCompleted = true
      },
      isPromptVisible: () => this.promptVisible,
      clearVisiblePrompt: () => this.clearVisiblePromptForOnboarding(),
      showToast: () => this.maybeShow('onboarding_completed', 'toast')
    })
  }

  private clearVisiblePromptForOnboarding(): void {
    // Why: onboarding completion is a stronger app-level value moment than a
    // threshold card that may have fired behind the wizard.
    this.promptVisible = false
    this.promptSession = null
    this.agentValueMoment.clear()
    this.broadcastHide()
  }

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
    logStarNagConsoleEvent(
      this.store,
      this.stats,
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
    // Why: opening GitHub is only a handoff, not verified star success. Keep the
    // ask quiet for the normal cooldown, but do not set starNagCompleted.
    deferAfterStarNagWebHandoff(this.store, this.stats, STAR_NAG_COOLDOWN_MS)
    this.promptVisible = false
    this.promptSession = null
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
    const starred = await runStarNagDirectStarAttempt(session)
    if (starred) {
      this.markCompleted()
    }
    return starred
  }

  /** User successfully starred or opted out → never nag again. */
  private markCompleted(): void {
    this.store.updateUI({ starNagCompleted: true, starNagDeferredUntil: null })
    this.promptVisible = false
    this.promptSession = null
    this.pendingForceShow = false
    this.pendingOnboardingCompleted = false
    this.agentValueMoment.clear()
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
