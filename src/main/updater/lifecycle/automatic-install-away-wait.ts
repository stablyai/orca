const AWAY_RECHECK_MS = 60_000
export const AUTOMATIC_INSTALL_AWAY_SECONDS = 600

type AwayWaitPorts = {
  mustWait: () => boolean
  isPending: (version: string) => boolean
  install: () => void
}

export class AutomaticInstallAwayWait {
  private timer: ReturnType<typeof setTimeout> | undefined
  private version: string | null = null

  constructor(private readonly ports: AwayWaitPorts) {}

  holds(version: string): boolean {
    if (!this.ports.mustWait()) {
      this.stop()
      return false
    }
    this.version = version
    if (!this.timer) {
      this.timer = setTimeout(() => this.recheck(), AWAY_RECHECK_MS)
      this.timer.unref?.()
    }
    return true
  }

  private stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.version = null
  }

  private recheck(): void {
    this.timer = undefined
    const version = this.version
    if (version === null || !this.ports.isPending(version)) {
      this.version = null
      return
    }
    if (!this.holds(version)) {
      this.ports.install()
    }
  }
}
