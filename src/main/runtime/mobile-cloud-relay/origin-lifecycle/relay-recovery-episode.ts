import { shouldRetryRelayConnectionError } from '../director/relay-http-client'

// A pool retry is trusted over the coordinator's rebuild only for a bounded time, and never once
// it failed for a reason a retry cannot fix (a non-retryable director 4xx on the relay token).
const RECOVERY_TRUST_MS = 5 * 60_000

export class RelayRecoveryEpisode {
  private startedAt: number | null = null
  private fatal = false

  begin(): void {
    this.startedAt ??= Date.now()
  }

  failed(error: unknown): void {
    this.fatal = !shouldRetryRelayConnectionError(error)
  }

  succeeded(): void {
    this.startedAt = null
    this.fatal = false
  }

  get trusted(): boolean {
    return this.startedAt !== null && !this.fatal && Date.now() - this.startedAt < RECOVERY_TRUST_MS
  }
}
