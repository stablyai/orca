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

  constructor(private readonly onChanged: () => void) {}

  /** The poll's calls say whether Orca Cloud answers; a call cut short by a stop says nothing. */
  tracked(transport: ConnectorTransport): ConnectorTransport {
    return {
      call: async (path, body, schema, options) => {
        const result = await transport.call(path, body, schema, options)
        if (!options?.signal?.aborted) {
          this.reached(result)
        }
        return result
      }
    }
  }

  reached(result: ConnectorResult<unknown>): void {
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
  }
}
