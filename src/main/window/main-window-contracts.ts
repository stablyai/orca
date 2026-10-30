import type { KeybindingOverrides } from '../../shared/keybindings'
import type { LowCommitOomVerdict } from '../crash-reporting/low-commit-oom-recovery-gate'
import type {
  RecoveryExhaustionCause,
  RecoveryReloadMilestone,
  RecoveryReloadTrigger
} from './renderer-recovery-reload-watchdog'
import type { RendererLivenessAtDeath } from './renderer-liveness-at-death'

/** Per-load outcome from Electron's load promise, which is scoped to that one load unlike `did-finish-load`. */
export type MainWindowLoadObserver = {
  onLoaded?: () => void
  onError?: (error: Error) => void
}

export type CreateMainWindowOptions = {
  /** Returns true when a manual app.quit() (Cmd+Q) is in progress, so the renderer skips the running-process confirm dialog. */
  getIsQuitting?: () => boolean
  /** Clear the quit latch if renderer beforeunload vetoes app.quit. */
  onQuitAborted?: () => void
  onRendererProcessGone?: (
    details: Electron.RenderProcessGoneDetails,
    webContentsId: number,
    liveness: RendererLivenessAtDeath
  ) => void
  /** Intentional update/quit teardown must not trigger renderer recovery. */
  shouldRecoverRenderer?: (
    details: Electron.RenderProcessGoneDetails,
    webContentsId: number
  ) => boolean
  /** Surface breaker exhaustion or a recovery load that produced no document. */
  onRendererRecoveryExhausted?: (info: {
    details: Electron.RenderProcessGoneDetails
    webContentsId: number
    recentRecoveryCount: number
    cause?: RecoveryExhaustionCause
    /** Set with cause 'low-commit': the Windows commit reading that stopped the auto-reload. */
    lowCommit?: LowCommitOomVerdict
    /** Watch manual retries too so a second stall can raise the prompt again. */
    retry?: () => void
  }) => void
  /** Defer renderer load until IPC handlers are registered, or eager renderer calls race into missing channels. */
  deferLoad?: boolean
  /** Reveal after load instead of first paint when startup must show the shell before slower renderer work. */
  revealOnDidFinishLoad?: boolean
  title?: string
  getKeybindings?: () => KeybindingOverrides | undefined
  onBeforeReload?: (options: { ignoreCache: boolean; webContentsId: number }) => void
  /** Spare live PTYs from orphan sweeping until recovery restore (#5787); distinguish manual retries from automatic-recovery breadcrumbs. */
  onBeforeRecoveryReload?: (webContentsId: number, trigger: RecoveryReloadTrigger) => void
  /** Pair load outcomes with reload-intent breadcrumbs so stalled and landed attempts are distinguishable. */
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
    /** ERR_* only; Electron load-error messages embed private URLs. */
    errorCode?: string
  }) => void
}
