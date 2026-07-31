import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { withEndpointRouteDeadline } from './mobile-endpoint-supervisor-support'

export class MobileRelayCredentialBundleLoader {
  private bundle: MobileRelayCredentialBundle | null = null
  private load: Promise<MobileRelayCredentialBundle | null> | null = null

  constructor(
    private readonly read: (hostId: string) => Promise<MobileRelayCredentialBundle | null>,
    private readonly setTimer: typeof setTimeout,
    private readonly clearTimer: typeof clearTimeout
  ) {}

  start(hostId: string, onLoaded: (bundle: MobileRelayCredentialBundle) => void): void {
    this.load = this.read(hostId).catch(() => null)
    void this.load.then((bundle) => {
      this.bundle = bundle
      if (bundle) {
        onLoaded(bundle)
      }
    })
  }

  current(): MobileRelayCredentialBundle | null {
    return this.bundle
  }

  replace(bundle: MobileRelayCredentialBundle): void {
    this.bundle = bundle
  }

  async wait(timeoutMs: number): Promise<MobileRelayCredentialBundle | null> {
    if (this.bundle || !this.load) {
      return this.bundle
    }
    return withEndpointRouteDeadline({
      promise: this.load,
      timeoutMs,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer
    })
  }
}
