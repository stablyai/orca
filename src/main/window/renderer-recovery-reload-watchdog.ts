import { is } from '@electron-toolkit/utils'
import type { BrowserWindow } from 'electron'
import { isSystemSessionEnding } from '../crash-reporting/expected-teardown-state'
import type { CreateMainWindowOptions, MainWindowLoadObserver } from './main-window-contracts'
import { mainWindowLoadErrorCode } from './main-window-load-error-code'

// Field recoveries took up to 30.4s; allow 45s before retrying a load with no document.
export const RENDERER_RECOVERY_LOAD_TIMEOUT_MS = 45_000
// Vite cold starts need a longer budget than packaged files.
export const RENDERER_RECOVERY_DEV_LOAD_TIMEOUT_MS = 180_000
// Retry once before handing recovery back to the user.
const RENDERER_RECOVERY_LOAD_ATTEMPTS = 2
// Milestones may extend the budget, but cannot postpone the prompt indefinitely.
const RENDERER_RECOVERY_LOAD_CAP_FACTOR = 2

/** Automatic recovery vs the prompt's manual Reload; they must not share one breadcrumb name. */
export type RecoveryReloadTrigger = 'automatic' | 'manual-retry'

/** How far a load got. Ranked, so an attempt's milestone only ever moves forward. */
export type RecoveryReloadMilestone = 'none' | 'committed' | 'dom-ready'
const MILESTONE_RANK: Record<RecoveryReloadMilestone, number> = {
  none: 0,
  committed: 1,
  'dom-ready': 2
}

export type RecoveryExhaustionCause = 'crash-loop' | 'reload-stalled'

export type RendererRecoveryReloadWatchdog = {
  /** Issues a recovery reload and arms the stall watchdog. */
  issue: (
    details: Electron.RenderProcessGoneDetails,
    recentRecoveryCount: number,
    trigger?: RecoveryReloadTrigger
  ) => void
  /** Raises the recovery prompt at most once: a native message box cannot be dismissed, so a second one stacks. */
  escalate: (subject: RecoveryPromptSubject, cause: RecoveryExhaustionCause) => void
  /**
   * A main-frame document finished loading. Only an attempt whose load was superseded takes this as its outcome;
   * every other attempt settles through its own load promise, which an error page or a later navigation cannot fool.
   */
  notifyDocumentLoaded: () => void
  /** Restarts the stall budget after a suspend froze the timer mid-load. */
  notifySystemResume: () => void
  clear: () => void
}

type RecoveryReload = {
  attempt: number
  details: Electron.RenderProcessGoneDetails
  recentRecoveryCount: number
  /** Never rewritten: the elapsedMs a crash bundle reads has to stay time-since-issue. */
  issuedAt: number
  /** Absolute deadline. A suspend pushes it out; a milestone cannot. */
  capAt: number
  milestone: RecoveryReloadMilestone
  progressedSinceArm: boolean
  /** Chromium aborted this load for a later navigation, which now owns the outcome. */
  superseded: boolean
}

type RecoveryReloadSeed = Pick<RecoveryReload, 'attempt' | 'details' | 'recentRecoveryCount'>
/** What a raised prompt is about; the crash-loop breaker has no attempt to hand over, only the crash. */
export type RecoveryPromptSubject = Pick<RecoveryReload, 'details' | 'recentRecoveryCount'>

/** Bounds stalled recovery reloads while still observing success after escalation. */
export function createRendererRecoveryReloadWatchdog(args: {
  /** True when a renderer death has already queued its own recovery, which then owns the next load. */
  isRecoveryPending: () => boolean
  isWindowClosing: () => boolean
  mainWindow: BrowserWindow
  opts?: CreateMainWindowOptions
  reloadMainWindow: (observer: MainWindowLoadObserver) => void
  rendererWebContentsId: number
}): RendererRecoveryReloadWatchdog {
  const {
    isRecoveryPending,
    isWindowClosing,
    mainWindow,
    opts,
    reloadMainWindow,
    rendererWebContentsId
  } = args
  // Cache before teardown: accessing a destroyed window's webContents throws.
  const rendererWebContents = mainWindow.webContents
  let inFlight: RecoveryReload | null = null
  // Retain timed-out loads so a late success can disarm the prompt's Reload.
  let latest: RecoveryReload | null = null
  // Keep one prompt until answered; native message boxes cannot be dismissed programmatically.
  let prompt: RecoveryPromptSubject | null = null
  let documentLanded = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  // Match loadMainWindow's dev/prod branch.
  const timeoutMs = (): number =>
    is.dev && process.env.ELECTRON_RENDERER_URL
      ? RENDERER_RECOVERY_DEV_LOAD_TIMEOUT_MS
      : RENDERER_RECOVERY_LOAD_TIMEOUT_MS

  const armTimer = (reload: RecoveryReload): void => {
    clearTimer()
    reload.progressedSinceArm = false
    timer = setTimeout(
      () => onBudgetExpired(reload),
      Math.max(0, Math.min(timeoutMs(), reload.capAt - Date.now()))
    )
    timer.unref?.()
  }

  const onBudgetExpired = (reload: RecoveryReload): void => {
    if (inFlight !== reload) {
      return
    }
    // Give a progressing load the remaining budget instead of restarting it cold.
    if (reload.progressedSinceArm && Date.now() < reload.capAt) {
      armTimer(reload)
      return
    }
    fail(reload)
  }

  const start = (seed: RecoveryReloadSeed, trigger: RecoveryReloadTrigger): void => {
    const issuedAt = Date.now()
    const reload: RecoveryReload = {
      ...seed,
      issuedAt,
      capAt: issuedAt + timeoutMs() * RENDERER_RECOVERY_LOAD_CAP_FACTOR,
      milestone: 'none',
      progressedSinceArm: false,
      superseded: false
    }
    inFlight = reload
    latest = reload
    documentLanded = false
    // Preserve live PTYs until renderer session restore (#5787).
    opts?.onBeforeRecoveryReload?.(mainWindow.webContents.id, trigger)
    // Only this load's promise distinguishes success from stale events and error pages.
    reloadMainWindow({
      onLoaded: () => settleLoaded(reload),
      onError: (error) => onLoadRejected(reload, mainWindowLoadErrorCode(error))
    })
    armTimer(reload)
  }

  const settleLoaded = (reload: RecoveryReload): void => {
    // A replaced attempt's promise may resolve on the replacement document.
    if (reload !== latest) {
      return
    }
    latest = null
    documentLanded = true
    if (reload === inFlight) {
      inFlight = null
      clearTimer()
    }
    opts?.onRecoveryReloadOutcome?.({
      status: 'loaded',
      attempt: reload.attempt,
      elapsedMs: Math.max(0, Date.now() - reload.issuedAt),
      // Record late recovery even if the prompt has already appeared.
      ...(prompt ? { afterPrompt: true } : {}),
      // Replacement timings must be excluded from recovery-load budget analysis.
      ...(reload.superseded ? { superseded: true } : {})
    })
  }

  // ERR_ABORTED transfers ownership to a replacement; the cap still bounds a silent replacement.
  const onLoadRejected = (reload: RecoveryReload, errorCode: string): void => {
    if (errorCode !== 'ERR_ABORTED') {
      fail(reload, errorCode)
      return
    }
    if (latest !== reload) {
      return
    }
    reload.superseded = true
    if (inFlight === reload) {
      armTimer(reload)
    }
  }

  const retryFrom = (subject: RecoveryPromptSubject): void => {
    prompt = null
    // A late recovery makes the prompt's Reload unnecessary.
    if (documentLanded) {
      return
    }
    start(
      { attempt: 1, details: subject.details, recentRecoveryCount: subject.recentRecoveryCount },
      'manual-retry'
    )
  }

  const escalate = (subject: RecoveryPromptSubject, cause: RecoveryExhaustionCause): void => {
    // A new crash invalidates any document that landed while the prompt was open.
    documentLanded = false
    if (prompt) {
      return
    }
    prompt = subject
    opts?.onRendererRecoveryExhausted?.({
      details: subject.details,
      webContentsId: rendererWebContentsId,
      recentRecoveryCount: subject.recentRecoveryCount,
      cause,
      // Watch manual retries too, so another stall can offer recovery again.
      retry: () => retryFrom(subject)
    })
  }

  const fail = (reload: RecoveryReload, errorCode?: string): void => {
    // Only the live attempt owns a failure verdict.
    if (inFlight !== reload) {
      return
    }
    // Suppress shutdown verdicts; resume may re-arm the retained attempt.
    if (
      isWindowClosing() ||
      opts?.getIsQuitting?.() ||
      mainWindow.isDestroyed() ||
      isSystemSessionEnding()
    ) {
      return
    }
    inFlight = null
    clearTimer()
    opts?.onRecoveryReloadOutcome?.({
      status: errorCode === undefined ? 'timeout' : 'failed',
      attempt: reload.attempt,
      // Wall-clock changes must not produce negative diagnostic durations.
      elapsedMs: Math.max(0, Date.now() - reload.issuedAt),
      progress: reload.milestone,
      ...(errorCode === undefined ? {} : { errorCode })
    })
    // A pending prompt or crash recovery owns the next reload.
    if (prompt || isRecoveryPending()) {
      return
    }
    // Restart only loads with no document; preserve progress until the user chooses Reload.
    if (reload.attempt < RENDERER_RECOVERY_LOAD_ATTEMPTS && reload.milestone === 'none') {
      start({ ...reload, attempt: reload.attempt + 1 }, 'automatic')
      return
    }
    escalate(reload, 'reload-stalled')
  }

  // Commit and DOM-ready distinguish a blank load from a document still loading.
  const observeMilestone = (milestone: RecoveryReloadMilestone) => (): void => {
    if (!inFlight || MILESTONE_RANK[milestone] <= MILESTONE_RANK[inFlight.milestone]) {
      return
    }
    inFlight.milestone = milestone
    inFlight.progressedSinceArm = true
  }
  const onDidNavigate = observeMilestone('committed')
  const onDomReady = observeMilestone('dom-ready')
  const onDidFailLoad = (
    _event: Electron.Event,
    errorCode: number,
    errorDescription: string,
    _validatedURL: string,
    isMainFrame: boolean
  ): void => {
    if (!isMainFrame || errorCode === -3 || !latest?.superseded) {
      return
    }
    // Error documents also finish loading; only a successful replacement may settle an aborted attempt.
    latest.superseded = false
    documentLanded = false
    fail(latest, mainWindowLoadErrorCode(new Error(errorDescription)))
  }
  rendererWebContents.on('did-navigate', onDidNavigate)
  rendererWebContents.on('dom-ready', onDomReady)
  rendererWebContents.on('did-fail-load', onDidFailLoad)

  return {
    issue: (details, recentRecoveryCount, trigger = 'automatic') =>
      start({ attempt: 1, details, recentRecoveryCount }, trigger),
    escalate,
    notifyDocumentLoaded: () => {
      // Timed-out replacements can still recover beneath the prompt.
      if (latest?.superseded) {
        settleLoaded(latest)
      }
    },
    // Restore the budget after sleep without rewriting the diagnostic issue time.
    notifySystemResume: () => {
      if (!inFlight) {
        return
      }
      inFlight.capAt = Date.now() + timeoutMs() * RENDERER_RECOVERY_LOAD_CAP_FACTOR
      armTimer(inFlight)
    },
    clear: () => {
      inFlight = null
      latest = null
      prompt = null
      clearTimer()
      rendererWebContents.off?.('did-navigate', onDidNavigate)
      rendererWebContents.off?.('dom-ready', onDomReady)
      rendererWebContents.off?.('did-fail-load', onDidFailLoad)
    }
  }
}
