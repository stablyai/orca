// Line-editor-ready markers can flush immediately; earlier markers need a settling delay.
export const POST_READY_FLUSH_DELAY_MS = 30
export const POST_READY_FLUSH_FALLBACK_MS = 200

export class PostReadyFlushGate {
  private awaitingPromptDraw = false
  private postDataTimer: ReturnType<typeof setTimeout> | null = null
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly onFlush: () => void,
    private readonly markerIsLineEditorReady = false
  ) {}

  /** Preserve input queuing until the actual flush, even after shell-ready is reported. */
  get isPending(): boolean {
    return this.awaitingPromptDraw || this.postDataTimer !== null || this.fallbackTimer !== null
  }

  /** Wait for post-marker output, with a bounded fallback if none arrives. */
  arm(postMarkerBytesObserved = false): void {
    if (this.markerIsLineEditorReady) {
      this.onFlush()
      return
    }
    this.awaitingPromptDraw = true
    if (postMarkerBytesObserved) {
      this.notifyData()
      return
    }
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null
      this.awaitingPromptDraw = false
      this.onFlush()
    }, POST_READY_FLUSH_FALLBACK_MS)
  }

  /** Give the line editor time to enter raw mode after its first post-marker output. */
  notifyData(): void {
    if (!this.awaitingPromptDraw) {
      return
    }
    this.awaitingPromptDraw = false
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
    if (this.postDataTimer === null) {
      this.postDataTimer = setTimeout(() => {
        this.postDataTimer = null
        this.onFlush()
      }, POST_READY_FLUSH_DELAY_MS)
    }
  }

  clear(): void {
    this.awaitingPromptDraw = false
    if (this.postDataTimer) {
      clearTimeout(this.postDataTimer)
      this.postDataTimer = null
    }
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
  }
}
