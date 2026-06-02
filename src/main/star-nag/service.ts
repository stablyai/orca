import { app, BrowserWindow, ipcMain } from 'electron'
import { STAR_NAG_INITIAL_THRESHOLD } from '../../shared/constants'
import { checkOrcaStarred } from '../github/client'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'

type StarNagPromptSource = 'threshold' | 'force_show'

type StarNagPromptSession = {
  source: StarNagPromptSource
}

/**
 * Service that decides when to prompt the user with the "star Orca on GitHub"
 * notification. Counts agents spawned since the current app version was first
 * seen; crosses a doubling threshold (default 50 → 100 → 200 …) to fire the
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
  // at 55 agents with threshold 50 would fork gh on every spawn until they
  // act on the card.
  private promptVisible = false
  // Why: prevent concurrent gh invocations if agents spawn rapidly during the
  // tiny window between crossing the threshold and the first gh check
  // resolving.
  private evaluating = false
  private pendingForceShow = false
  // Why: dismissal backoff should only apply to a prompt that was actually
  // delivered, and the dismissal payload needs the delivered prompt source.
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
    ipcMain.handle('star-nag:complete', () => this.markCompleted())
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
      // Why: the notification is only useful for users whose gh CLI can
      // actually perform the star. Calling checkOrcaStarred both gates on gh
      // availability and skips users who already starred outside the app.
      // Errors (network, gh missing) map to null — skip silently and leave
      // state unchanged so we retry on the next spawn without racing forward
      // to the next threshold.
      const starred = await checkOrcaStarred()
      if (starred === null) {
        return
      }
      if (starred) {
        // Already starred somewhere — lock in the permanent suppression so we
        // stop recomputing thresholds on every spawn.
        this.markCompleted()
        return
      }
      if (this.store.getUI().starNagCompleted) {
        this.pendingForceShow = false
        return
      }
      if (this.promptVisible) {
        return
      }
      this.broadcastShow(source)
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
    this.broadcastShow('force_show')
  }

  private broadcastShow(source: StarNagPromptSource): boolean {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) {
      this.promptVisible = false
      this.promptSession = null
      return false
    }
    win.webContents.send('star-nag:show')
    this.promptVisible = true
    this.promptSession = { source }
    this.logConsoleEvent('star_nag_shown', source)
    return true
  }

  private logConsoleEvent(
    event: 'star_nag_shown' | 'star_nag_dismissed',
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
   * User closed the notification without starring → double the threshold and
   * rebase the baseline so the next fire is "threshold more agents since this
   * dismissal" (not "threshold total since install"). This matches the
   * product intent of exponential back-off: 50 more, then 100 more, then 200
   * more, etc.
   */
  private dismiss(): void {
    const session = this.promptSession
    if (!session) {
      this.promptVisible = false
      return
    }
    const ui = this.store.getUI()
    const threshold = ui.starNagNextThreshold ?? STAR_NAG_INITIAL_THRESHOLD
    const nextThreshold = threshold * 2
    this.logConsoleEvent('star_nag_dismissed', session.source, nextThreshold)
    this.store.updateUI({
      starNagNextThreshold: nextThreshold,
      starNagBaselineAgents: this.stats.getTotalAgentsSpawned()
    })
    this.promptVisible = false
    this.promptSession = null
  }

  /** User successfully starred → never nag again. */
  private markCompleted(): void {
    this.store.updateUI({ starNagCompleted: true })
    this.promptVisible = false
    this.promptSession = null
    this.pendingForceShow = false
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
    this.broadcastShow('force_show')
  }
}
