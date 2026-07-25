export type RendererSandboxCrashFallbackOptions = {
  /** Window after launch in which clustered renderer breakpoints indicate a sandbox-incompatible build. */
  windowMs: number
  /** Launch-window STATUS_BREAKPOINT renderer crashes that trigger the unsandboxed-renderer fallback. */
  threshold: number
}

// Why: on Win11 build 26200 the sandboxed renderer breakpoints during startup
// (STATUS_BREAKPOINT / 0x80000003) within ~2s, repeatedly, on nearly every
// launch (#9891). Disabling hardware acceleration does not help - the renderer
// sandbox itself is unusable on this build - so a burst right after launch is
// the signal to relaunch with the top-level renderer unsandboxed.
// Why 60s (vs the GPU tracker's 30s): GPU child processes die pre-window, but
// the renderer breakpoints ~2s AFTER the window loads, so the launch burst can
// land later on a slow cold start. Matching the renderer-recovery breaker's 60s
// window means any breakpoint loop the breaker would react to is preempted by
// this fallback first, instead of dead-ending at the "keeps failing to load" dialog.
export const DEFAULT_RENDERER_SANDBOX_FALLBACK_WINDOW_MS = 60_000
export const DEFAULT_RENDERER_SANDBOX_FALLBACK_THRESHOLD = 3

// Windows STATUS_BREAKPOINT (0x80000003) as a signed 32-bit exit code. This is
// Chromium's generic CHECK/IMMEDIATE_CRASH code on Windows, not a sandbox-unique
// signature, so the fallback is best-effort and degrades safely if ineffective.
export const STATUS_BREAKPOINT_EXIT_CODE = -2147483645

/**
 * Tracks launch-time renderer STATUS_BREAKPOINT crashes and decides when to
 * relaunch this build with the top-level renderer unsandboxed. Pure and
 * deterministic: callers pass `msSinceLaunch` so behavior is testable without
 * timers, mirroring {@link GpuCrashFallbackTracker}.
 *
 * Only crashes inside the post-launch window count: a renderer that dies hours
 * into a session is not a launch-time sandbox incompatibility.
 */
export class RendererSandboxCrashFallbackTracker {
  private readonly windowMs: number
  private readonly threshold: number
  private crashesInWindow = 0
  private engaged = false

  constructor(options: RendererSandboxCrashFallbackOptions) {
    this.windowMs = options.windowMs
    this.threshold = options.threshold
  }

  /**
   * Records a renderer breakpoint at `msSinceLaunch` and reports whether this
   * crash just pushed the count over the threshold (i.e. fallback should engage
   * now). Returns false for crashes outside the window or after fallback already
   * engaged, so the caller relaunches at most once.
   */
  recordRendererCrash(msSinceLaunch: number): {
    shouldEngageFallback: boolean
    crashesInWindow: number
  } {
    if (
      this.engaged ||
      !Number.isFinite(msSinceLaunch) ||
      msSinceLaunch < 0 ||
      msSinceLaunch > this.windowMs
    ) {
      return { shouldEngageFallback: false, crashesInWindow: this.crashesInWindow }
    }
    this.crashesInWindow += 1
    if (this.crashesInWindow >= this.threshold) {
      this.engaged = true
      return { shouldEngageFallback: true, crashesInWindow: this.crashesInWindow }
    }
    return { shouldEngageFallback: false, crashesInWindow: this.crashesInWindow }
  }

  hasEngaged(): boolean {
    return this.engaged
  }
}

/**
 * True for the renderer crashes that should feed the sandbox-fallback tracker:
 * a win32 top-level renderer that exited with STATUS_BREAKPOINT. Deliberately
 * narrow so renderer OOM (#9872, exit -36861) and non-Windows crashes never trip
 * the sandbox downgrade.
 */
export function isRendererSandboxFallbackCrashCandidate({
  platform,
  source,
  exitCode
}: {
  platform: NodeJS.Platform
  source: 'renderer' | 'child'
  exitCode: number | null
}): boolean {
  return platform === 'win32' && source === 'renderer' && exitCode === STATUS_BREAKPOINT_EXIT_CODE
}
