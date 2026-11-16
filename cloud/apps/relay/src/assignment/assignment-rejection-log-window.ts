type CancelWindow = () => void

// At ~17 rejections/s, log window open and timer-driven close with suppressed count; quiet keys still report their final totals.
const MAX_TRACKED_KEYS = 64

type RejectionWindow<TSample> = {
  suppressed: number
  sample: TSample
  cancel: CancelWindow
}

export class AssignmentRejectionLogWindow<TSample> {
  private readonly windows = new Map<string, RejectionWindow<TSample>>()

  constructor(
    private readonly options: {
      windowMs: number
      onWindowClosed: (input: { key: string; suppressed: number; sample: TSample }) => void
      schedule?: (callback: () => void, delayMs: number) => CancelWindow
    }
  ) {}

  // Returns true when the caller should log this rejection immediately.
  admit(key: string, sample: TSample): boolean {
    const open = this.windows.get(key)
    if (open) {
      open.suppressed++
      // Keep the most recent host/reason so the closing line names a real rejection.
      open.sample = sample
      return false
    }
    const schedule = this.options.schedule ?? defaultSchedule
    const window: RejectionWindow<TSample> = { suppressed: 0, sample, cancel: () => undefined }
    this.windows.set(key, window)
    if (this.windows.size > MAX_TRACKED_KEYS) {
      this.close(this.windows.keys().next().value!)
    }
    window.cancel = schedule(() => this.close(key), this.options.windowMs)
    return true
  }

  private close(key: string): void {
    const window = this.windows.get(key)
    if (!window) return
    this.windows.delete(key)
    window.cancel()
    if (window.suppressed === 0) return
    this.options.onWindowClosed({ key, suppressed: window.suppressed, sample: window.sample })
  }
}

function defaultSchedule(callback: () => void, delayMs: number): CancelWindow {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
