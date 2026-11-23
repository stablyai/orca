import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  LEGACY_JOURNAL_RETIREMENT_ACK_METHOD,
  LEGACY_JOURNAL_RETIREMENT_CLAIM_METHOD
} from '../../../../shared/remote-runtime/protocol/legacy-journal-retirement-forwarding'
import {
  legacyJournalRetirementHostVersionSchema,
  legacyJournalRetirementSchema
} from '../../../../shared/telemetry/schemas/telemetry-legacy-journal-retirement-schema'
import { isTelemetryEnabled, onTelemetryEnabled, track } from '../../../telemetry/client'
import type { RetirementEventSocket } from './runtime-environment-retirement-events'

const ClaimResult = z.strictObject({
  event: legacyJournalRetirementSchema,
  hostAppVersion: legacyJournalRetirementHostVersionSchema,
  deliveryId: z.uuid()
})
const DELIVERY_TIMEOUT_MS = 5_000

export class RemoteLegacyJournalRetirement {
  private closed = false
  private delivering = false
  private requested = false
  private stopListening: (() => void) | undefined

  constructor(
    private readonly socket: RetirementEventSocket,
    private readonly subscriptionId: string,
    private readonly runtimeId: string
  ) {}

  available(): void {
    if (!this.live()) {
      return
    }
    this.stopListening ??= onTelemetryEnabled(() => this.available())
    this.requested = true
    this.deliver()
  }

  close(): void {
    this.closed = true
    this.stopListening?.()
    this.stopListening = undefined
  }

  private live(): boolean {
    return !this.closed && this.socket.isCurrent()
  }

  private deliver(): void {
    if (!this.requested || this.delivering || !this.live() || !isTelemetryEnabled()) {
      return
    }
    this.requested = false
    this.delivering = true
    void this.claimAndTrack()
      .finally(() => {
        this.delivering = false
        this.deliver()
      })
      .catch(() => {})
  }

  private async claimAndTrack(): Promise<void> {
    // The desktop supplies the token so it can release a claim even if its reply was lost.
    const claim = { subscriptionId: this.subscriptionId, token: randomUUID() }
    let release = true
    try {
      const response = await this.socket.request(
        LEGACY_JOURNAL_RETIREMENT_CLAIM_METHOD,
        claim,
        DELIVERY_TIMEOUT_MS
      )
      if (!response.ok) {
        if (response.error.code === 'method_not_found') {
          this.socket.disableForwarding()
          this.close()
          release = false
        }
        return
      }
      if (response.result === null) {
        release = false
        return
      }
      const result = ClaimResult.safeParse(response.result)
      if (!this.live() || response._meta.runtimeId !== this.runtimeId || !result.success) {
        return
      }
      const accepted = track('legacy_journal_retirement', {
        ...result.data.event,
        runtime: 'remote',
        host_app_version: result.data.hostAppVersion
      })
      if (!accepted || !this.live()) {
        return
      }
      const ack = await this.socket.request(
        LEGACY_JOURNAL_RETIREMENT_ACK_METHOD,
        { ...claim, accepted: true, deliveryId: result.data.deliveryId },
        DELIVERY_TIMEOUT_MS
      )
      if (ack.ok && typeof ack.result === 'boolean') {
        release = false
        if (ack.result === true && ack._meta.runtimeId === this.runtimeId && !this.requested) {
          this.stopListening?.()
          this.stopListening = undefined
        }
      } else if (!ack.ok && ack.error.code === 'method_not_found') {
        this.socket.disableForwarding()
        this.close()
      }
    } finally {
      if (release) {
        // Cancel through the endpoint that granted the claim, even if acknowledgement is unavailable.
        this.socket.cleanup(LEGACY_JOURNAL_RETIREMENT_CLAIM_METHOD, { ...claim, release: true })
      }
    }
  }
}
