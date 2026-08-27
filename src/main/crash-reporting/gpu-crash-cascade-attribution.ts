/** Renderer deaths this close behind a GPU child crash are the same fault. */
export const DEFAULT_GPU_CASCADE_WINDOW_MS = 2_000

export type GpuCascadeCrash = { at: number; exitCode: number | null }

/**
 * Links a renderer crash back to the GPU child crash that caused it.
 *
 * Why: a GPU fault usually surfaces twice — the suppressed child-process-gone
 * and, moments later, the renderer going down with the same exit code. Counting
 * the tail as its own GPU crash is what lets a "one crash per launch" loop reach
 * the fallback threshold, and the paired event names the real cause in the
 * crash trail instead of leaving an unexplained renderer death.
 *
 * TODO: fold into the shared recent-process-gone ring in process-gone-recorder
 * once it lands.
 */
export class GpuCrashCascadeAttributor {
  private readonly windowMs: number
  private pending: GpuCascadeCrash | null = null

  constructor(options: { windowMs?: number } = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_GPU_CASCADE_WINDOW_MS
  }

  /** Arms attribution after a GPU child crash that did not engage fallback. */
  noteSuppressedGpuCrash(crash: GpuCascadeCrash): void {
    this.pending = crash
  }

  /**
   * True when this renderer death is the tail of the armed GPU crash. Claiming
   * disarms, so one GPU crash can only ever produce one cascade event.
   */
  claimRendererCascade(crash: { reason: string; exitCode: number | null; at: number }): boolean {
    const pending = this.pending
    if (
      !pending ||
      crash.reason !== 'crashed' ||
      crash.exitCode !== pending.exitCode ||
      crash.at < pending.at ||
      crash.at - pending.at > this.windowMs
    ) {
      return false
    }
    this.pending = null
    return true
  }
}
