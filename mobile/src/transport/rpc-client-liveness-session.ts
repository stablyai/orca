import {
  RpcSessionLivenessWatchdog,
  type LivenessTimeoutEvidence
} from './rpc-session-liveness-watchdog'
import type { RpcClientSocketSession } from './rpc-client-socket-session'

export const LIVENESS_REQUEST_ID_PREFIX = 'mobile-liveness-'

export function isLivenessProbeResponseId(id: string): boolean {
  return id.startsWith(LIVENESS_REQUEST_ID_PREFIX)
}

// Why: the watchdog is per authenticated socket; a probe or terminate on a retired
// session would kill the socket that replaced it.
export class RpcClientLivenessSession {
  private readonly watchdog: RpcSessionLivenessWatchdog
  private session: RpcClientSocketSession | null = null

  constructor(
    private readonly options: {
      sendProbe: (probeId: string) => boolean
      terminate: (session: RpcClientSocketSession) => void
      onTimeout: (evidence: LivenessTimeoutEvidence) => void
      nextId: () => string
    }
  ) {
    this.watchdog = new RpcSessionLivenessWatchdog({
      transport: 'direct',
      sendProbe: (identity) =>
        identity === this.session
          ? this.options.sendProbe(`${LIVENESS_REQUEST_ID_PREFIX}${this.options.nextId()}`)
          : false,
      terminate: (identity) => {
        if (identity === this.session && this.session) {
          this.options.terminate(this.session)
        }
      },
      onTimeout: this.options.onTimeout
    })
  }

  start(session: RpcClientSocketSession): void {
    this.session = session
    this.watchdog.start(session)
  }

  stop(session?: RpcClientSocketSession): void {
    if (!this.session || (session && this.session !== session)) {
      return
    }
    this.watchdog.stop(this.session)
    this.session = null
  }

  probeNow(): void {
    if (this.session) {
      this.watchdog.probeNow(this.session)
    }
  }

  noteInbound(session: RpcClientSocketSession): void {
    this.watchdog.noteAuthenticatedInbound(session)
  }

  getLastInboundAt(): number | null {
    return this.watchdog.getLastInboundAt() || null
  }
}
