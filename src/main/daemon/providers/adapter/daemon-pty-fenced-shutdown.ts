import {
  isPtyFencedTerminationOutcome,
  type PtyFencedTerminationRequest,
  type PtyFencedTerminationOutcome
} from '../../../../shared/terminal/pty/lifecycle/pty-fenced-termination'
import { FENCED_TERMINATION_PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import { DaemonPtyPreservedHostLoss } from './daemon-pty-preserved-host-loss'

export abstract class DaemonPtyFencedShutdown extends DaemonPtyPreservedHostLoss {
  supportsFencedTermination(_id: string): boolean {
    return this.protocolVersion >= FENCED_TERMINATION_PROTOCOL_VERSION
  }

  async killFenced(
    request: PtyFencedTerminationRequest,
    assertCurrent?: (allowAbsent?: boolean) => void
  ): Promise<PtyFencedTerminationOutcome> {
    if (!this.supportsFencedTermination(request.id)) {
      return { outcome: 'refused', reason: 'unsupported' }
    }
    // Capture the checked identity before waiting on connection or lifecycle locks.
    const { id, expectedIncarnationId, requireNoAgentOwner, requireUnattached } = request
    try {
      return await this.withHistorySpawnLock(id, async () => {
        const incarnationBeforeKill = this.sessionIncarnations.get(id)
        await this.ensureConnected()
        assertCurrent?.()
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
        assertCurrent?.(true)
        const currentIncarnationId = this.sessionIncarnations.get(id)
        if (
          (result.outcome === 'ended' || result.outcome === 'already_exited') &&
          (incarnationBeforeKill === undefined ||
            incarnationBeforeKill === expectedIncarnationId) &&
          (currentIncarnationId === undefined || currentIncarnationId === expectedIncarnationId)
        ) {
          // Exit may clear the incarnation first; hold the spawn lock through removal to protect replacement sessions.
          await this.completeShutdownWithHistoryLock(id, {})
        }
        return result
      })
    } catch {
      return { outcome: 'refused', reason: 'unverifiable' }
    }
  }
}
