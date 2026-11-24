import type { ConnectorResult } from './connector-cloud-request'
import type { ConnectorTransport } from './connector-machine'

/** Orca Cloud answering again: the poll after its own outage ('recovered'), the poll after a call outside it
 *  got no answer ('answered'), or an account signing in. */
export type ConnectorBack = 'recovered' | 'answered' | 'signedIn'

/** Whether the running poll's calls reach Orca Cloud, and what the cloud says when it refuses them. */
export class ConnectorReach {
  // The running poll's last call got no answer from Orca Cloud, or a 5xx.
  unreachable = false
  // The cloud's words on the running poll's last refused call, e.g. too many machines on the account.
  refusal: string | null = null
  // The connector-token route refused this sign-in on the running poll's last call, after a fresh session.
  unauthorized = false

  private readonly backListeners = new Set<(why: ConnectorBack) => void>()
  // A call outside the poll got no answer: the poll's next answer is the cloud answering again for it.
  private missed = false

  constructor(private readonly onChanged: () => void) {}

  onBack(listener: (why: ConnectorBack) => void): () => void {
    this.backListeners.add(listener)
    return () => this.backListeners.delete(listener)
  }

  /** A call outside the poll (a bot's picture) the cloud didn't answer, or answered with a 5xx. */
  missedOutsidePoll(result: ConnectorResult<unknown>): void {
    if (!result.ok && (result.status === null || result.status >= 500)) {
      this.missed = true
    }
  }

  back(why: ConnectorBack): void {
    for (const listener of this.backListeners) {
      listener(why)
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
    const cameBack =
      !unreachable && (this.unreachable ? 'recovered' : this.missed ? 'answered' : null)
    if (!unreachable) {
      this.missed = false
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
      this.back(cameBack)
    }
  }
}
