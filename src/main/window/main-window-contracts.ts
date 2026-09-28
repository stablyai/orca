import type { KeybindingOverrides } from '../../shared/keybindings'
import type {
  RecoveryExhaustionCause,
  RecoveryReloadMilestone,
  RecoveryReloadTrigger
} from './renderer-recovery-reload-watchdog'

/** Per-load outcome from Electron's load promise, which is scoped to that one load unlike `did-finish-load`. */
export type MainWindowLoadObserver = {
  onLoaded?: () => void
  onError?: (error: Error) => void
}

export type CreateMainWindowOptions = {
  /** Returns true when a manual app.quit() (Cmd+Q) is in progress, so the renderer skips the running-process confirm dialog. */
  getIsQuitting?: () => boolean
  /** Notifies the caller when the renderer vetoes unload, so the quit latch clears — a prevented beforeunload cancels the in-flight app.quit(). */
  onQuitAborted?: () => void
  onRendererProcessGone?: (
    details: Electron.RenderProcessGoneDetails,
    webContentsId: number
  ) => void
  /** Returns true when Orca should reload after renderer loss; update-relaunch/quit tear down children intentionally, so don't fight shutdown. */
  shouldRecoverRenderer?: (
    details: Electron.RenderProcessGoneDetails,
    webContentsId: number
  ) => boolean
  /** Called when auto-recovery gives up — the breaker opened, or the recovery reload never produced a document. */
  onRendererRecoveryExhausted?: (info: {
    details: Electron.RenderProcessGoneDetails
    webContentsId: number
    recentRecoveryCount: number
    cause?: RecoveryExhaustionCause
    /** Watched manual retry for the recovery prompt; an unwatched one cannot re-raise the prompt when it stalls too. */
    retry?: () => void
  }) => void
  /** Defer renderer load until IPC handlers are registered, or eager renderer calls race into missing channels. */
  deferLoad?: boolean
  /** Reveal after load instead of first paint when startup must show the shell before slower renderer work. */
  revealOnDidFinishLoad?: boolean
  title?: string
  getKeybindings?: () => KeybindingOverrides | undefined
  onBeforeReload?: (options: { ignoreCache: boolean; webContentsId: number }) => void
  /**
   * Marks the in-place recovery reload so did-finish-load's PTY orphan sweep spares live sessions until restore
   * re-attaches (#5787). The prompt's manual Reload is one too, so `trigger` keeps the automatic-recovery
   * breadcrumb counting only automatic recoveries.
   */
  onBeforeRecoveryReload?: (webContentsId: number, trigger: RecoveryReloadTrigger) => void
  /** Pairs an outcome with the recovery-reload intent crumb: bundles could not tell a landed reload from a stalled one. */
  onRecoveryReloadOutcome?: (outcome: {
    status: 'loaded' | 'timeout' | 'failed'
    attempt: number
    elapsedMs: number
    /** How far the load got: 'none' is the blank-window field failure, anything else a document that then hung. */
    progress?: RecoveryReloadMilestone
    /** True when the load landed after the recovery prompt was already raised — the recovery worked. */
    afterPrompt?: boolean
    /** True when a later navigation replaced this load: elapsedMs then measures the replacement, not the reload. */
    superseded?: boolean
    /** `ERR_*` code only, for the same reason — Electron's load-error message embeds the URL. */
    errorCode?: string
  }) => void
}
