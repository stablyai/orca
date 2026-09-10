import { MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD } from './mobile-runtime-client-capabilities'
import { readHostProtocolVerdict, type CompatVerdict } from './protocol-compat'
import type { RpcResponse } from './types'

export const HOST_UNVERIFIED_MESSAGE = 'Host compatibility has not been verified'

// Physical authentication frames precede RPC; capability negotiation and liveness status
// also run inside direct/relay sessions before the logical client is connected.
export const HOST_PROTOCOL_BOOTSTRAP_METHODS = new Set([
  'status.get',
  MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
  'pairing.provisionRelay',
  'pairing.getEndpoints'
])

export class HostProtocolAdmission {
  private verdict: CompatVerdict = { kind: 'unknown' }
  private probe: { answered: Promise<void>; settle: () => void } | null = null

  allows(method: string): boolean {
    return this.verdict.kind === 'ok' || HOST_PROTOCOL_BOOTSTRAP_METHODS.has(method)
  }

  /** Opened when a status probe is written, so callers can tell "deciding" from "refused". */
  beginProbe(): void {
    if (this.probe) {
      return
    }
    let settle = (): void => {}
    const answered = new Promise<void>((resolve) => {
      settle = resolve
    })
    this.probe = { answered, settle }
  }

  endProbe(): void {
    this.probe?.settle()
    this.probe = null
  }

  /** The probe deciding this generation, or null when nothing is going to change the verdict. */
  whenProbed(): Promise<void> | null {
    return this.probe?.answered ?? null
  }

  reset(): void {
    this.verdict = { kind: 'unknown' }
    // The replacement generation's probe has not been written yet; nobody may wait on this one.
    this.endProbe()
  }

  observe(response: RpcResponse): void {
    const verdict = response.ok
      ? readHostProtocolVerdict(response.result)
      : { kind: 'unknown' as const }
    // A transient failure cannot revoke this generation's verified compatibility.
    if (verdict.kind !== 'unknown') {
      this.verdict = verdict
    }
  }
}
