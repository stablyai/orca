import { pendingTerminalHistoryRetirement } from '../../../pty/pending-terminal-history-retirement'
import { admitProspectivePtySpawn } from '../../../pty/prospective-pty-spawn'
import { DaemonHistoryRetirement } from './daemon-history-retirement'
import { fencedTerminationHistoryPolicy } from '../../../pty/pty-history-preserving-termination'
import {
  isPtyFencedTerminationOutcome,
  type PtyFencedTerminationRequest,
  type PtyFencedTerminationOutcome
} from '../../../../shared/terminal/pty/lifecycle/pty-fenced-termination'
import { FENCED_TERMINATION_PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import { sameEndpointIdentity } from '../../endpoint/identity/daemon-endpoint-incarnation'
import { DaemonPtyDaemonRecovery } from './daemon-pty-daemon-recovery'
export abstract class DaemonPtyFencedTermination extends DaemonPtyDaemonRecovery {
  async [admitProspectivePtySpawn]() {
    if (this.retired || this.idleRetirementAdmissionClosed || !this.supportsFencedTermination('')) {
      return null
    }
    await this.ensureConnected()
    const endpoint = this.client.getDaemonIdentity()
    if (!endpoint) {
      return null
    }
    let released = false
    return {
      current: () =>
        !released &&
        !this.retired &&
        !this.idleRetirementAdmissionClosed &&
        this.client.isConnected() &&
        (() => {
          const now = this.client.getDaemonIdentity()
          return !!now && sameEndpointIdentity(endpoint, now)
        })(),
      currentSync: () =>
        !released &&
        !this.retired &&
        !this.idleRetirementAdmissionClosed &&
        this.client.isConnected() &&
        (() => {
          const now = this.client.getDaemonIdentity()
          return !!now && sameEndpointIdentity(endpoint, now)
        })(),
      release: () => {
        released = true
      }
    }
  }

  supportsFencedTermination(_id: string): boolean {
    return this.protocolVersion >= FENCED_TERMINATION_PROTOCOL_VERSION
  }

  [pendingTerminalHistoryRetirement](request: PtyFencedTerminationRequest) {
    const receipt = this.historyRetirements.get(request.id)
    return receipt?.incarnationId === request.expectedIncarnationId ? receipt : undefined
  }

  async killFenced(request: PtyFencedTerminationRequest): Promise<PtyFencedTerminationOutcome> {
    if (!this.supportsFencedTermination(request.id)) {
      return { outcome: 'refused', reason: 'unsupported' }
    }
    // Capture the checked identity before waiting on connection or lifecycle locks.
    const { id, expectedIncarnationId, requireNoAgentOwner, requireUnattached } = request
    const policy = fencedTerminationHistoryPolicy(request)
    let retirement = this.historyRetirements.get(id)
    if (policy.keepHistory && !retirement) {
      const writer = this.historyManager?.captureWriter(id)
      const endpoint = this.lastAuthenticatedIdentity
      if (
        !writer ||
        !endpoint ||
        this.sessionIncarnations.get(id) !== expectedIncarnationId ||
        !this.historyManager
      ) {
        return { outcome: 'refused', reason: 'unverifiable' }
      }
      const captured = new DaemonHistoryRetirement(
        expectedIncarnationId,
        endpoint,
        this.historyManager,
        id,
        writer,
        this.checkpointQueue,
        () => {
          if (this.historyRetirements.get(id) === captured) {
            this.historyRetirements.delete(id)
          }
          this.keepHistoryShutdowns.delete(captured.completion)
        }
      )
      retirement = captured
      this.historyRetirements.set(id, captured)
      this.keepHistoryShutdowns.add(captured.completion)
    }
    if (policy.keepHistory && retirement?.incarnationId !== expectedIncarnationId) {
      return { outcome: 'refused', reason: 'replaced' }
    }
    try {
      return await this.withHistorySpawnLock(id, async () => {
        const incarnationBeforeKill = this.sessionIncarnations.get(id)
        await this.ensureConnected()
        const result = await this.client.request<unknown>('kill', {
          sessionId: id,
          immediate: true,
          expectedIncarnationId,
          requireNoAgentOwner,
          requireUnattached
        })
        if (!isPtyFencedTerminationOutcome(result)) {
          return { outcome: 'refused', reason: 'unverifiable' }
        }
        const currentIncarnationId = this.sessionIncarnations.get(id)
        if (
          (result.outcome === 'ended' || result.outcome === 'already_exited') &&
          (incarnationBeforeKill === undefined ||
            incarnationBeforeKill === expectedIncarnationId) &&
          (currentIncarnationId === undefined || currentIncarnationId === expectedIncarnationId)
        ) {
          // Exit may clear the incarnation first; hold the spawn lock through removal to protect replacement sessions.
          if (policy.keepHistory) {
            await retirement?.finish(true)
          }
          await this.completeShutdownWithHistoryLock(id, policy)
        }
        if (
          result.outcome === 'refused' &&
          result.reason !== 'unverifiable' &&
          !retirement?.exited
        ) {
          await retirement?.finish(result.reason === 'replaced')
        }
        return result
      })
    } catch {
      return { outcome: 'refused', reason: 'unverifiable' }
    }
  }
}
