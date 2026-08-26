import { redactSocketEndpoint } from './socket-event-debug'

const AUTH_RETRY_BUDGET = 3

type AuthenticationRetryOptions = {
  endpoint: string
  stopLiveness: () => void
  emitWarning: (message: string, detail: string) => void
  retry: (reason: string) => void
  latchFailure: (reason: string) => void
}

export class RpcClientAuthenticationRetry {
  private rejectionCount = 0

  constructor(private readonly options: AuthenticationRetryOptions) {}

  accepted(): void {
    this.rejectionCount = 0
  }

  reject(reason: string, preserveRecovery = false): void {
    this.options.stopLiveness()
    this.rejectionCount++
    if (this.rejectionCount < AUTH_RETRY_BUDGET) {
      console.log('[net] auth rejected — retrying handshake', {
        attempt: this.rejectionCount,
        budget: AUTH_RETRY_BUDGET,
        endpoint: redactSocketEndpoint(this.options.endpoint)
      })
      this.options.emitWarning(
        'Authentication rejected',
        `Retrying (${this.rejectionCount}/${AUTH_RETRY_BUDGET})`
      )
      if (!preserveRecovery) {
        this.options.retry(reason)
      }
      return
    }
    console.log('[net] auth rejected — budget exhausted, latching auth-failed', {
      attempt: this.rejectionCount,
      endpoint: redactSocketEndpoint(this.options.endpoint)
    })
    this.options.latchFailure(reason)
  }
}
