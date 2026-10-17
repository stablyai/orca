export const STATUS_ONLY_SIDECAR_IDLE_MS = 60_000

/**
 * Releases a sidecar that only ever answered permission-status reads.
 *
 * Why: the setup checklist reads status at launch; that must not keep a sidecar and provider alive
 * for users who never run Computer Use. Any other call pins the session so agent snapshot state
 * survives pauses.
 */
export class StatusOnlySidecarIdleRelease {
  private statusOnly = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly release: () => void) {}

  started(): void {
    this.statusOnly = true
  }

  served(method: string): void {
    if (method !== 'permissionStatus') {
      this.statusOnly = false
      this.cancel()
    }
  }

  /** Called when the request queue drains. */
  idle(): void {
    this.cancel()
    if (!this.statusOnly) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.statusOnly) {
        this.release()
      }
    }, STATUS_ONLY_SIDECAR_IDLE_MS)
    this.timer.unref?.()
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
