import type { ConnectorResult } from './connector-cloud-request'
import type { ConnectorTransport } from './connector-machine'

/** Whether the running poll's calls reach Orca Cloud, and what the cloud says when it refuses them. */
export class ConnectorReach {
  // The running poll's last call got no answer from Orca Cloud, or a 5xx.
  unreachable = false
  // The cloud's words on the running poll's last refused call, e.g. too many machines on the account.
  refusal: string | null = null
  // The connector-token route refused this sign-in on the running poll's last call, after a fresh session.
  unauthorized = false

  private readonly backListeners = new Set<() => void>()
  // A call outside the poll got no answer: the poll's next answer is the cloud answering again for it. Once
  // per run of misses, so a route that keeps failing while the poll answers is not retried at its pace.
  private missed = false
  private missRetried = false

  constructor(private readonly onChanged: () => void) {}

  onBack(listener: () => void): () => void {
    this.backListeners.add(listener)
    return () => this.backListeners.delete(listener)
  }

  /** A call outside the poll (a bot's picture) the cloud didn't answer, or answered with a 5xx. */
  missedOutsidePoll(result: ConnectorResult<unknown>): void {
    if (result.ok) {
      this.missRetried = false
    } else if ((result.status === null || result.status >= 500) && !this.missRetried) {
      this.missed = true
    }
  }

  back(): void {
    for (const listener of this.backListeners) {
      listener()
    }
  }

  /** Calls outside the poll: one Orca Cloud didn't answer makes the poll's next answer a step back. */
  outsidePoll(transport: ConnectorTransport): Pick<ConnectorTransport, 'call'> {
    return {
      call: async (path, body, schema, options) => {
        const result = await transport.call(path, body, schema, options)
        if (!options?.signal?.aborted) {
          this.missedOutsidePoll(result)
        }
        return result
      }
    }
  }

  /** The poll's calls say whether Orca Cloud answers; a call cut short by a stop says nothing. */
  tracked(transport: ConnectorTransport): ConnectorTransport {
    return {
      call: async (path, body, schema, options) => {
        const result = await transport.call(path, body, schema, options)
        if (!options?.signal?.aborted) {
          this.reached(result)
        }
        return result
      },
      ...(transport.wakeToken && { wakeToken: transport.wakeToken.bind(transport) })
    }
  }

  reached(result: ConnectorResult<unknown>): void {
    const unreachable = !result.ok && (result.status === null || result.status >= 500)
    const refusal = result.ok ? null : (result.message ?? null)
    const unauthorized = !result.ok && result.sessionRefused === true
    const cameBack = (this.unreachable || this.missed) && !unreachable
    if (!unreachable && this.missed) {
      this.missed = false
      this.missRetried = true
    }
    if (
      this.unreachable !== unreachable ||
      this.refusal !== refusal ||
      this.unauthorized !== unauthorized
    ) {
      this.unreachable = unreachable
      this.refusal = refusal
      this.unauthorized = unauthorized
      this.onChanged()
    }
    if (cameBack) {
      this.back()
    }
  }
}
