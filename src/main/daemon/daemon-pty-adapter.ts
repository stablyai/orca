import {
  isPtyFencedTerminationOutcome,
  type PtyFencedTerminationRequest,
  type PtyFencedTerminationOutcome
} from '../../shared/pty-fenced-termination'
import { FENCED_TERMINATION_PROTOCOL_VERSION } from './daemon-protocol-version'
import { emitPtyListeners, createPtyExitPayload } from './daemon-pty-listener-emission'
import { DaemonPtyDaemonRecovery } from './daemon-pty-daemon-recovery'
import type { DaemonPtyAdapterOptions } from './daemon-pty-runtime-state'
import { supportsMode2031UnsubscribeFact, type DaemonEvent } from './types'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { DeveloperPermissionStatus } from '../../shared/developer-permissions-types'
import {
  AUTOMATIC_WORK_RESUME_UNSUPPORTED,
  type AutomaticWorkResumeOutcome,
  type AutomaticWorkResumeResult,
  type AutomaticWorkStatus
} from '../../shared/host-spawn-admission'
import { isUnknownRequestTypeError } from './daemon-endpoint-errors'
import type { AutomaticWorkRequestType } from './daemon-automatic-work-protocol'
import type { DaemonAsyncIoStatus } from '../../shared/daemon-async-io-health'

export class DaemonPtyAdapter extends DaemonPtyDaemonRecovery implements IPtyProvider {
  constructor(opts: DaemonPtyAdapterOptions) {
    super(opts)
    // Registered after the base listener, which marks the sessions awaiting recovery first.
    this.client.onDisconnected(() => this.recoverAfterEndpointLoss())
  }

  supportsFencedTermination(_id: string): boolean {
    return this.protocolVersion >= FENCED_TERMINATION_PROTOCOL_VERSION
  }

  async killFenced(request: PtyFencedTerminationRequest): Promise<PtyFencedTerminationOutcome> {
    if (!this.supportsFencedTermination(request.id)) {
      return { outcome: 'refused', reason: 'unsupported' }
    }
    // Capture the checked identity before waiting on connection or lifecycle locks.
    const { id, expectedIncarnationId, requireNoAgentOwner, requireUnattached } = request
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
          await this.completeShutdownWithHistoryLock(id, {})
        }
        return result
      })
    } catch {
      return { outcome: 'refused', reason: 'unverifiable' }
    }
  }

  async getAsyncIoHealth(): Promise<DaemonAsyncIoStatus> {
    if (!this.client.isConnected()) {
      return { state: 'unverifiable' }
    }
    try {
      const health = await this.client.request<unknown>('asyncIoHealth', undefined, 7_000)
      if (
        health &&
        typeof health === 'object' &&
        'state' in health &&
        (health.state === 'healthy' || health.state === 'stalled') &&
        'pendingMs' in health &&
        typeof health.pendingMs === 'number' &&
        Number.isFinite(health.pendingMs) &&
        health.pendingMs >= 0
      ) {
        return { state: health.state, pendingMs: health.pendingMs }
      }
    } catch (error) {
      if (isUnknownRequestTypeError(error)) {
        return { state: 'unsupported' }
      }
    }
    return { state: 'unverifiable' }
  }

  async getFullDiskAccessStatus(): Promise<DeveloperPermissionStatus> {
    if (!this.client.isConnected()) {
      return 'unknown'
    }
    try {
      const result = await this.client.request<unknown>('fullDiskAccessStatus', undefined, 3000)
      if (result && typeof result === 'object' && 'status' in result) {
        const { status } = result
        if (status === 'granted' || status === 'denied' || status === 'unsupported') {
          return status
        }
      }
    } catch {
      // Older daemons and lost host contact cannot establish a permission verdict.
    }
    return 'unknown'
  }

  /** Identity of the daemon behind this adapter; null until hello completes or after a disconnect. */
  getDaemonIdentity(): DaemonEndpointIdentity | null {
    return this.client.getDaemonIdentity()
  }

  protected setupEventRouting(): void {
    if (this.removeEventListener) {
      return
    }

    this.removeEventListener = this.client.onEvent((raw) => {
      const event = raw as DaemonEvent
      if (event.type !== 'event') {
        return
      }

      if (event.event === 'data') {
        this.markSessionDirty(event.sessionId)
        emitPtyListeners(this.dataListeners, (listener) =>
          listener({
            id: event.sessionId,
            data: event.payload.data,
            ...((event.payload.rawLength ?? event.payload.sequenceChars) === undefined
              ? {}
              : { sequenceChars: event.payload.rawLength ?? event.payload.sequenceChars }),
            ...(event.payload.transformed ? { transformed: true } : {}),
            ...(event.payload.seq === undefined ? {} : { seq: event.payload.seq })
          })
        )
      } else if (event.event === 'sessionBackgroundMarker') {
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'backgroundMarker',
          background: event.payload.background,
          ...(event.payload.scanSeedAnsi !== undefined
            ? { scanSeedAnsi: event.payload.scanSeedAnsi }
            : {}),
          ...(event.payload.mode2031PendingSubscribe
            ? { mode2031PendingSubscribe: true as const }
            : {})
        })
      } else if (event.event === 'dataGap') {
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'dataGap',
          droppedChars: event.payload.droppedChars,
          ...(event.payload.sequenceChars === undefined
            ? {}
            : { sequenceChars: event.payload.sequenceChars })
        })
      } else if (event.event === 'transientFact') {
        // Why (#9993): a preserved pre-v29 daemon can retain a stale relay tracker. Its
        // unretractable subscribe is harmful; an unsubscribe is always safe to forward.
        if (
          event.payload.kind === '2031-subscribe' &&
          !supportsMode2031UnsubscribeFact(this.protocolVersion)
        ) {
          return
        }
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'transientFact',
          fact: event.payload
        })
      } else if (event.event === 'exit') {
        const currentIncarnationId = this.sessionIncarnations.get(event.sessionId)
        const pendingOperations = new Set([
          ...(this.pendingSpawnOperationsBySessionId.get(event.sessionId) ?? []),
          ...this.pendingClaimSpawnOperations
        ])
        for (const operation of pendingOperations) {
          if (operation.ignoreNextExit) {
            operation.ignoreNextExit = false
            continue
          }
          const exits = operation.exitsBySessionId.get(event.sessionId) ?? []
          exits.push(
            event.payload.incarnationId
              ? { code: event.payload.code, incarnationId: event.payload.incarnationId }
              : { code: event.payload.code }
          )
          operation.exitsBySessionId.set(event.sessionId, exits)
        }
        // Retain raced exits for pending spawns; only this adapter's published incarnation may clear state or notify.
        if (
          currentIncarnationId !== undefined &&
          event.payload.incarnationId !== currentIncarnationId
        ) {
          return
        }
        this.clearExitedSessionState(
          event.sessionId,
          event.payload.code,
          event.payload.incarnationId
        )
        emitPtyListeners(this.exitListeners, (listener) =>
          listener(createPtyExitPayload(event.sessionId, event.payload))
        )
      }
    })
  }

  async getAutomaticWorkStatus(): Promise<AutomaticWorkStatus | null> {
    const status = await this.requestAutomaticWork<AutomaticWorkStatus>('automaticWorkStatus')
    return status === AUTOMATIC_WORK_RESUME_UNSUPPORTED ? null : status
  }

  resumeAutomaticWork(): Promise<AutomaticWorkResumeOutcome> {
    return this.requestAutomaticWork<AutomaticWorkResumeResult>('resumeAutomaticWork')
  }

  private async requestAutomaticWork<T>(
    type: AutomaticWorkRequestType
  ): Promise<T | typeof AUTOMATIC_WORK_RESUME_UNSUPPORTED> {
    await this.ensureConnected()
    try {
      return await this.client.request<T>(type, undefined)
    } catch (error) {
      // Unsupported requests cannot prove a recorded pause is absent.
      if (isUnknownRequestTypeError(error)) {
        return AUTOMATIC_WORK_RESUME_UNSUPPORTED
      }
      throw error
    }
  }

  async closeStartupQueryAuthority(id: string): Promise<number> {
    if (!this.supportsStartupIngress) {
      return 0
    }
    const result = await this.client.request<{ appliedSeq: number }>('closeStartupQueryAuthority', {
      sessionId: id
    })
    return result.appliedSeq
  }
}
