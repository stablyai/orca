import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-paths'
import type { ConnectorResult } from './connector-cloud-request'
import type { ConnectorTransport } from './connector-machine'

/** What a failed bot picture may go again on: the poll answering ('answered'), the poll answering after its
 *  own outage ('recovered'), or a completed sign-in or account switch ('signedIn'). Only `/poll` answers
 *  count, so the events outbox and other calls never make one. */
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
  // A `/poll` got no answer or a 5xx since the cloud last took one: its next taken poll ends that outage.
  private pollDown = false
  private signInThisTurn = false

  constructor(private readonly onChanged: () => void) {}

  onBack(listener: (why: ConnectorBack) => void): () => void {
    this.backListeners.add(listener)
    return () => this.backListeners.delete(listener)
  }

  back(why: ConnectorBack): void {
    // A sign-in that also switched the account says so twice in one turn: it is one step.
    if (why === 'signedIn') {
      if (this.signInThisTurn) {
        return
      }
      this.signInThisTurn = true
      queueMicrotask(() => {
        this.signInThisTurn = false
      })
    }
    for (const listener of this.backListeners) {
      listener(why)
    }
  }

  /** The poll's calls say whether Orca Cloud answers; a call cut short by a stop says nothing. */
  tracked(transport: ConnectorTransport): ConnectorTransport {
    return {
      call: async (path, body, schema, options) => {
        const result = await transport.call(path, body, schema, options)
        if (!options?.signal?.aborted) {
          this.reached(result, path)
        }
        return result
      },
      ...(transport.wakeToken && { wakeToken: transport.wakeToken.bind(transport) })
    }
  }

  /** The poll stopped (sign-out, quit, a fence): what it knew is let go, and no cloud came back. */
  stopped(): void {
    const changed = this.unreachable || this.refusal !== null || this.unauthorized
    this.unreachable = false
    this.refusal = null
    this.unauthorized = false
    if (changed) {
      this.onChanged()
    }
  }

  reached(result: ConnectorResult<unknown>, path?: string): void {
    const unreachable = !result.ok && (result.status === null || result.status >= 500)
    const refusal = result.ok ? null : (result.message ?? null)
    const unauthorized = !result.ok && result.sessionRefused === true
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
    // Only a `/poll` the cloud took ends its outage: a refusal from it is no answer for a picture.
    if (path === CONNECTOR_PATHS.poll && result.ok) {
      const recovered = this.pollDown
      this.pollDown = false
      this.back(recovered ? 'recovered' : 'answered')
    } else if (path === CONNECTOR_PATHS.poll && unreachable) {
      this.pollDown = true
    }
  }
}
