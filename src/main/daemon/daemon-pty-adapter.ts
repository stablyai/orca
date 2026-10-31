import {
  isPtyFencedTerminationOutcome,
  type PtyFencedTerminationRequest,
  type PtyFencedTerminationOutcome
} from '../../shared/pty-fenced-termination'
import { FENCED_TERMINATION_PROTOCOL_VERSION } from './daemon-protocol-version'
import { emitPtyListeners, createPtyExitPayload } from './daemon-pty-listener-emission'
import type { DaemonPtyRouterExitEvent } from './daemon-pty-router-events'
import { logWslPaneDiagnostic } from './daemon-wsl-diagnostic-log'
import { classifyWslBridgeExit, WSL_DISTRO_LOSS_EXIT_CODE } from './daemon-wsl-bridge-exit'
import { isProvenProcessExit } from '../../shared/terminal-exit-cause'
import { DaemonPtyDaemonRecovery } from './daemon-pty-daemon-recovery'
import type { DaemonPtyAdapterOptions } from './daemon-pty-runtime-state'
import {
  supportsMode2031UnsubscribeFact,
  supportsUnseenOsc133Zones,
  type DaemonEvent
} from './types'
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
import { readDaemonAsyncIoHealth } from './daemon-async-io-health-read'

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

  getAsyncIoHealth(): Promise<DaemonAsyncIoStatus> {
    return readDaemonAsyncIoHealth(() => this.client, this.protocolVersion)
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

    this.removeEventListener = this.client.onEvent((raw, source) => {
      const event = raw as DaemonEvent
      if (event.type !== 'event') {
        return
      }

      const semanticSource = source
        ? { provider: this, stream: source.owner, terminalState: source.terminalState }
        : undefined
      if (event.event === 'data') {
        this.markSessionDirty(event.sessionId)
        emitPtyListeners(this.dataListeners, (listener) =>
          listener({
            id: event.sessionId,
            ...(semanticSource ? { semanticSource } : {}),
            data: event.payload.data,
            ...((event.payload.rawLength ?? event.payload.sequenceChars) === undefined
              ? {}
              : { sequenceChars: event.payload.rawLength ?? event.payload.sequenceChars }),
            ...(event.payload.transformed ? { transformed: true } : {}),
            ...(event.payload.seq === undefined ? {} : { seq: event.payload.seq })
          })
        )
      } else if (event.event === 'terminalObservation') {
        if (event.sessionId) {
          this.emitBackgroundStreamEvent({
            id: event.sessionId,
            kind: 'terminalObservation',
            ...(semanticSource ? { semanticSource } : {}),
            incarnationId: event.incarnationId,
            observation: event.payload
          })
        }
      } else if (event.event === 'sessionBackgroundMarker') {
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'backgroundMarker',
          ...(semanticSource ? { semanticSource } : {}),
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
        // Why: an older relay can still flush a queued OMP bubble close as a finished command.
        if (
          event.payload.kind === 'command-finished' &&
          !supportsUnseenOsc133Zones(this.protocolVersion)
        ) {
          return
        }
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
      } else if (event.event === 'inputClosed') {
        // Kept per incarnation: the report can land before its own spawn reply.
        this.inputClosedIncarnations.record(event.sessionId, event.payload.incarnationId)
      } else if (event.event === 'exit') {
        const currentIncarnationId = this.ptyInventory.currentIncarnation(event.sessionId)
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
          exits.push({
            code: event.payload.code,
            ...(event.payload.incarnationId ? { incarnationId: event.payload.incarnationId } : {}),
            ...(event.payload.cause ? { cause: event.payload.cause } : {})
          })
          operation.exitsBySessionId.set(event.sessionId, exits)
        }
        const wslDistro = this.wslDistrosBySessionId.get(event.sessionId)
        // Retain raced exits for pending spawns; only this adapter's published incarnation may clear state or notify.
        if (
          currentIncarnationId !== undefined &&
          event.payload.incarnationId !== currentIncarnationId
        ) {
          // A stale exit may still be a reboot's; the respawn that beat it re-reads its boot id.
          if (wslDistro) {
            this.wslBridgeBootIdentity.noteStaleExit(event.sessionId, wslDistro)
          }
          return
        }
        // Every bridge exit marks a possible stop (unseen to the user; covers poweroff or --shutdown).
        if (wslDistro) {
          this.wslBridgeBootIdentity.noteExit(wslDistro)
        }
        // A terminate never exits 0 (awin: -1 per bridge pane; `exit`/`exit 0` gave 0): a clean exit is
        // the user's own, so it closes at once, without the settle wait or classification.
        if (wslDistro && event.payload.code !== 0 && isProvenProcessExit(event.payload.code)) {
          const exitAt = performance.now()
          void this.finishWslBridgeExit(event.sessionId, event.payload, wslDistro, exitAt)
          return
        }
        this.finishExit(event.sessionId, event.payload)
      }
    })
  }

  private finishExit(sessionId: string, exit: Omit<DaemonPtyRouterExitEvent, 'id'>): void {
    this.clearExitedSessionState(sessionId, exit.code, exit.incarnationId)
    emitPtyListeners(this.exitListeners, (listener) =>
      listener(createPtyExitPayload(sessionId, exit))
    )
  }

  /** A bridge pane whose distro went away is host loss: it keeps its tab and restorable history. */
  private async finishWslBridgeExit(
    sessionId: string,
    exit: Omit<DaemonPtyRouterExitEvent, 'id'>,
    wslDistro: string,
    exitAt: number
  ): Promise<void> {
    const verdict = await classifyWslBridgeExit(wslDistro, exitAt, this.readRunningWslDistros, () =>
      this.wslBridgeBootIdentity.rebootedSinceSpawn(sessionId, wslDistro)
    )
    // Lost, or booted again since the spawn, keeps the tab; an unanswered check reads as an exit.
    // The code shows a verify run which codes a terminate yields.
    const probeMs = Math.round(performance.now() - exitAt)
    logWslPaneDiagnostic(
      'wsl.bridge-exit',
      {
        console: `[pty] WSL bridge exit: ${verdict} (distro ${wslDistro}, code ${exit.code}, probe ${probeMs}ms)`,
        trace: `[pty] WSL bridge exit: ${verdict} (code ${exit.code}, probe ${probeMs}ms)`
      },
      { verdict, code: exit.code, probeMs }
    )
    // A spawn that replaced this incarnation meanwhile owns the session now.
    const current = this.sessionIncarnations.get(sessionId)
    if (current !== undefined && current !== exit.incarnationId) {
      return
    }
    if (verdict !== 'lost' && verdict !== 'rebooted') {
      this.finishExit(sessionId, exit)
      return
    }
    const hostLoss = {
      code: WSL_DISTRO_LOSS_EXIT_CODE,
      incarnationId: exit.incarnationId,
      hostLost: true as const
    }
    this.hostLossSessionIds.add(sessionId)
    this.clearExitedSessionState(sessionId, hostLoss.code, hostLoss.incarnationId, {
      closeHistory: false
    })
    emitPtyListeners(this.exitListeners, (listener) =>
      listener(createPtyExitPayload(sessionId, hostLoss))
    )
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
