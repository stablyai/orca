import { readFile } from 'node:fs/promises'
import {
  classifyDaemonAuditFailure,
  type DaemonAuditObservation,
  type DaemonAuditTrigger
} from './daemon-audit-classifier'
import {
  exactDaemonIncarnationForPidRecord,
  sameEndpointIdentity
} from './daemon-endpoint-incarnation'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { DaemonEvidenceSource, ExactDaemonIncarnation } from './daemon-incarnation-evidence'
import { notifyDaemonAuditListeners } from './daemon-listener-registry'
import { DaemonPtyEventSubscriptions } from './daemon-pty-event-subscriptions'
import { parseDaemonPidFile, type ParsedDaemonPid } from './daemon-pid-file-parse'
import { supportsColorQueryReplyColors } from './daemon-protocol-version'
import type { TerminalOscColorQueryReplyColors } from '../../shared/terminal-osc-color-reply'

export abstract class DaemonPtyConnectionLifecycle extends DaemonPtyEventSubscriptions {
  private colorQueryReplyColors: TerminalOscColorQueryReplyColors | null = null

  setColorQueryReplyColors(colors: TerminalOscColorQueryReplyColors): void {
    this.colorQueryReplyColors = colors
    this.syncColorQueryReplyColors()
  }

  protected async ensureConnected(deadlineMs?: number): Promise<void> {
    try {
      // Bound destructive teardown's handshake by its deadline so a wedged connection fails promptly.
      await (deadlineMs !== undefined
        ? this.client.ensureConnectedWithin(Math.max(1, deadlineMs - Date.now()))
        : this.client.ensureConnected())
    } finally {
      // Release the temporary respawn pair once permanent reconnect succeeds or fails.
      this.releasePendingRespawnAdoptionLease()
    }
    this.recordAuthenticatedIdentity()
    // Sample before installing routing so a fresh connection resyncs daemon-local background state.
    const isFreshConnection = this.removeEventListener === null
    this.setupEventRouting()
    this.scheduleCheckpointTimer()
    this.flushOwedProducerResumes()
    if (isFreshConnection) {
      this.resyncBackgroundedSessions()
      // Replacement daemons lack colors; pushes sent while disconnected were dropped.
      this.syncColorQueryReplyColors()
    }
  }

  private syncColorQueryReplyColors(): void {
    if (this.colorQueryReplyColors && supportsColorQueryReplyColors(this.protocolVersion)) {
      this.client.notify('setColorQueryReplyColors', { colors: this.colorQueryReplyColors })
    }
  }

  protected recordAuthenticatedIdentity(): void {
    const current = this.client.getDaemonIdentity()
    if (!current) {
      return
    }
    const previous = this.lastAuthenticatedIdentity
    if (previous && sameEndpointIdentity(previous, current)) {
      return
    }
    if (previous) {
      // Recheck capabilities for each incarnation: the replacement may support getSize.
      this.getSizeUnsupported = false
    }
    this.lastAuthenticatedIdentity = { ...current }
    this.exactDaemonIncarnation = exactDaemonIncarnationForPidRecord(current, this.pidRecord)
    if (!previous) {
      return
    }
    const event = { previous: { ...previous }, current: { ...current } }
    notifyDaemonAuditListeners(this.identityChangeListeners, event)
  }

  protected async resolveExactDaemonIncarnation(
    exactIncarnation: ExactDaemonIncarnation | null
  ): Promise<ExactDaemonIncarnation | null> {
    if (
      !exactIncarnation ||
      process.platform !== 'linux' ||
      (exactIncarnation.linuxStartTicks && exactIncarnation.bootId)
    ) {
      return exactIncarnation
    }
    const cachedIncarnation = exactDaemonIncarnationForPidRecord(
      exactIncarnation.identity,
      this.pidRecord
    )
    if (cachedIncarnation.linuxStartTicks && cachedIncarnation.bootId) {
      return cachedIncarnation
    }
    const pidRecord = await this.readMatchingPidRecord(exactIncarnation.identity)
    this.pidRecord = pidRecord ?? this.pidRecord
    return pidRecord?.linuxStartTicks && pidRecord.bootId
      ? {
          identity: { ...exactIncarnation.identity },
          linuxStartTicks: pidRecord.linuxStartTicks,
          bootId: pidRecord.bootId
        }
      : exactIncarnation
  }

  protected cacheExactDaemonIncarnation(exactIncarnation: ExactDaemonIncarnation | null): void {
    if (
      exactIncarnation &&
      this.lastAuthenticatedIdentity &&
      sameEndpointIdentity(exactIncarnation.identity, this.lastAuthenticatedIdentity)
    ) {
      this.exactDaemonIncarnation = exactIncarnation
    }
  }

  protected async readMatchingPidRecord(
    identity: DaemonEndpointIdentity
  ): Promise<ParsedDaemonPid | null> {
    if (!this.pidPath) {
      return null
    }
    try {
      const parsed = parseDaemonPidFile(await readFile(this.pidPath, 'utf8'))
      return parsed?.pid === identity.pid &&
        parsed.startedAtMs === identity.startedAtMs &&
        parsed.launchNonce === identity.launchNonce
        ? parsed
        : null
    } catch {
      return null
    }
  }

  protected observeAuditFailure(
    trigger: Exclude<DaemonAuditTrigger, 'inventory_answered'>,
    exactIncarnation = this.exactDaemonIncarnation,
    additionalEvidenceSources: readonly DaemonEvidenceSource[] = [],
    endpointGoneProof?: 'windows_named_pipe_missing'
  ): void {
    void this.resolveExactDaemonIncarnation(exactIncarnation)
      .then((resolvedIncarnation) => {
        this.cacheExactDaemonIncarnation(resolvedIncarnation)
        return classifyDaemonAuditFailure(this.auditContext, trigger, resolvedIncarnation, {
          additionalEvidenceSources,
          endpointGoneProof
        })
      })
      .then((observation) => this.publishAuditObservation(observation))
      .catch(() => {})
  }

  protected publishAuditObservation(observation: DaemonAuditObservation): void {
    this.lastAuditObservation = observation
    this.trackAuditEligibility(observation)
    notifyDaemonAuditListeners(this.auditObservationListeners, observation)
  }

  protected resyncBackgroundedSessions(): void {
    for (const id of this.backgroundedSessionIds) {
      this.client.notify('setSessionBackground', { sessionId: id, background: true })
    }
  }

  protected flushOwedProducerResumes(): void {
    if (this.producerResumesOwedOnReconnect.size === 0) {
      return
    }
    for (const id of this.producerResumesOwedOnReconnect) {
      // Unknown-session resumes are harmless; a paused survivor otherwise waits for its failsafe.
      this.client.notify('resumePty', { sessionId: id })
    }
    this.producerResumesOwedOnReconnect.clear()
  }
}
