// Orca Cloud's shares_changed push (the connector wake socket): a burst, e.g. several shares revoked
// at once, is one read of the account's shares.
const COALESCE_MS = 500

export class SharedBotHostsPush {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly refresh: () => Promise<void>) {}

  changed(): void {
    this.timer ??= setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, COALESCE_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
