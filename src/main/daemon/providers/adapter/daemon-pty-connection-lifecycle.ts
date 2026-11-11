import { readFile } from 'node:fs/promises'
import {
  classifyDaemonAuditFailure,
  type DaemonAuditObservation
} from '../../observability/daemon-audit-classifier'
import type {
  DaemonAuditTrigger,
  DaemonEvidenceSource
} from '../../../../shared/daemon-audit-eligibility'
import {
  exactDaemonIncarnationForPidRecord,
  sameEndpointIdentity
} from '../../endpoint/identity/daemon-endpoint-incarnation'
import type { DaemonEndpointIdentity } from '../../protocol/daemon-hello-protocol'

import type { ExactDaemonIncarnation } from '../../endpoint/identity/daemon-incarnation-evidence-types'
import { notifyDaemonAuditListeners } from '../../observability/daemon-listener-registry'
import { DaemonPtyEventSubscriptions } from './daemon-pty-event-subscriptions'
import {
  parseDaemonPidFile,
  type ParsedDaemonPid
} from '../../endpoint/identity/daemon-pid-file-parse'
import {
  supportsColorQueryReplyColors,
  supportsRepoColorQueryReplyColors
} from '../../protocol/daemon-protocol-version'
import type { DaemonPtyAdapterOptions } from './daemon-pty-adapter-options'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal/protocol/queries/terminal-osc-color-reply'
import type { PtyOwnerRepoColors } from '../../../../shared/terminal/pty/ingress/pty-owner-color-query-colors'

export abstract class DaemonPtyConnectionLifecycle extends DaemonPtyEventSubscriptions {
  private colorQueryReplyColors: TerminalOscColorQueryReplyColors | null = null
  private repoColorQueryReplyColors: PtyOwnerRepoColors | null = null
  private colorQueryReplyColorsDelivery: 'owed' | 'sent' = 'owed'

  constructor(opts: DaemonPtyAdapterOptions) {
    super(opts)
    // Why: a push written just before a transport drop may never reach the daemon, which stays alive.
    this.client.onDisconnected(() => {
      this.colorQueryReplyColorsDelivery = 'owed'
    })
  }

  setColorQueryReplyColors(
    colors: TerminalOscColorQueryReplyColors,
    byRepoId?: PtyOwnerRepoColors
  ): void {
    this.colorQueryReplyColors = colors
    this.repoColorQueryReplyColors = byRepoId ?? this.repoColorQueryReplyColors
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
    }
    // Why not only fresh: a client-side drop keeps the event listener, yet the push it dropped is owed.
    if (isFreshConnection || this.colorQueryReplyColorsDelivery === 'owed') {
      this.syncColorQueryReplyColors()
    }
  }

  private syncColorQueryReplyColors(): void {
    if (!this.colorQueryReplyColors || !supportsColorQueryReplyColors(this.protocolVersion)) {
      return
    }
    // Idempotent on the daemon, so resending the whole state is always safe.
    const sent = this.client.notify('setColorQueryReplyColors', {
      colors: this.colorQueryReplyColors,
      ...(this.repoColorQueryReplyColors && supportsRepoColorQueryReplyColors(this.protocolVersion)
        ? { byRepoId: this.repoColorQueryReplyColors }
        : {})
    })
    this.colorQueryReplyColorsDelivery = sent ? 'sent' : 'owed'
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
      // Recheck capabilities for each incarnation: the replacement may support them.
      this.getSizeUnsupported = false
      this.focusLossReportRejected = false
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
