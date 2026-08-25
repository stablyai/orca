import { isUnknownRequestTypeError } from './daemon-endpoint-errors'
import { sameEndpointIdentity } from './daemon-endpoint-incarnation'
import { GET_SIZE_PROTOCOL_VERSION } from './daemon-protocol-version'
import { DaemonPtySessionSpawn } from './daemon-pty-session-spawn'
import type { ListSessionsResult } from './types'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TerminalOwnerIdentity } from '../../shared/terminal-owner-identity'

export const LIVENESS_PROBE_TIMEOUT_MS = 2_000

export abstract class DaemonPtySessionAuthority extends DaemonPtySessionSpawn {
  private listSessionsForLiveness(): Promise<ListSessionsResult> {
    if (this.livenessInventoryInFlight) {
      return this.livenessInventoryInFlight
    }
    const request = this.client.request<ListSessionsResult>(
      'listSessions',
      undefined,
      LIVENESS_PROBE_TIMEOUT_MS
    )
    this.livenessInventoryInFlight = request
    void request.then(
      () => {
        if (this.livenessInventoryInFlight === request) {
          this.livenessInventoryInFlight = null
        }
      },
      () => {
        if (this.livenessInventoryInFlight === request) {
          this.livenessInventoryInFlight = null
        }
      }
    )
    return request
  }

  async probePtyLiveness(
    id: string,
    expectedIncarnationId?: PtyIncarnationId,
    expectedOwnerIdentity?: TerminalOwnerIdentity
  ): Promise<boolean | null> {
    try {
      await this.ensureConnected(Date.now() + LIVENESS_PROBE_TIMEOUT_MS)
      const ownerIdentityAtProbe = this.lastAuthenticatedIdentity
        ? { ...this.lastAuthenticatedIdentity }
        : null
      const canConfirmAbsence =
        this.hasExactSessionAuthority(id, expectedIncarnationId) &&
        (expectedOwnerIdentity === undefined ||
          this.ownerIdentity(expectedIncarnationId ?? this.sessionIncarnations.get(id))
            ?.ownerIncarnationId === expectedOwnerIdentity.ownerIncarnationId)
      if (expectedOwnerIdentity !== undefined && !canConfirmAbsence) {
        return null
      }
      if (
        (expectedIncarnationId === undefined || canConfirmAbsence) &&
        !this.getSizeUnsupported &&
        this.protocolVersion >= GET_SIZE_PROTOCOL_VERSION
      ) {
        try {
          const result = await this.client.request<{ size: { cols: number; rows: number } | null }>(
            'getSize',
            { sessionId: id },
            LIVENESS_PROBE_TIMEOUT_MS
          )
          if (
            !ownerIdentityAtProbe ||
            !this.lastAuthenticatedIdentity ||
            !sameEndpointIdentity(ownerIdentityAtProbe, this.lastAuthenticatedIdentity)
          ) {
            return null
          }
          return result.size !== null ? true : canConfirmAbsence ? false : null
        } catch (error) {
          if (!isUnknownRequestTypeError(error)) {
            throw error
          }
          this.getSizeUnsupported = true
        }
      }
      const { sessions } = await this.listSessionsForLiveness()
      if (
        !ownerIdentityAtProbe ||
        !this.lastAuthenticatedIdentity ||
        !sameEndpointIdentity(ownerIdentityAtProbe, this.lastAuthenticatedIdentity)
      ) {
        return null
      }
      const liveSession = sessions.find((session) => session.sessionId === id && session.isAlive)
      if (liveSession) {
        this.recordSessionAuthority(id, liveSession.incarnationId)
        if (
          expectedIncarnationId !== undefined &&
          liveSession.incarnationId !== expectedIncarnationId
        ) {
          return canConfirmAbsence ? false : null
        }
        return true
      }
      return canConfirmAbsence ? false : null
    } catch {
      return null
    }
  }
}
