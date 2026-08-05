import {
  isRpcTransportControlMethod,
  RpcApplicationResponsiveness
} from './rpc-application-responsiveness'
import { TimedOutControlRequestIndex } from './timed-out-control-request-index'

export class RpcApplicationResponseTracker {
  private readonly timedOutRequestIds = new TimedOutControlRequestIndex()

  constructor(
    private readonly responsiveness = new RpcApplicationResponsiveness(),
    private readonly hooks: { onLatched?: (method: string) => void; onRecovered?: () => void } = {}
  ) {}

  recordTimeout(
    id: string,
    method: string,
    connected: boolean,
    applicationHealthProbe: boolean
  ): boolean {
    if (!connected || !applicationHealthProbe || isRpcTransportControlMethod(method)) {
      return false
    }
    const result = this.responsiveness.recordTimeout()
    if (result.latched) {
      this.hooks.onLatched?.(method)
    }
    if (result.latched || result.recycle) {
      this.timedOutRequestIds.remember(id)
    }
    return result.recycle
  }

  recordControlPlaneFailure(probeMethod: string): void {
    if (this.responsiveness.recordControlPlaneFailure()) {
      this.hooks.onLatched?.(probeMethod)
    }
  }

  recordResponse(method: string): void {
    if (this.responsiveness.recordResponse(method)) {
      this.hooks.onRecovered?.()
    }
  }

  consumeLateResponse(id: string): boolean {
    if (!this.timedOutRequestIds.consume(id)) {
      return false
    }
    if (this.responsiveness.recordApplicationResponse()) {
      this.hooks.onRecovered?.()
    }
    return true
  }

  getUnresponsiveSince(): number | null {
    return this.responsiveness.getUnresponsiveSince()
  }
}
