import { createAdmissionStreamClient } from './daemon-terminal-stream-client'
import type { BackgroundTransientFactRelay } from './daemon-background-transient-facts'
import type { DaemonClientConnections } from './daemon-client-connections'
import type { DaemonEndpointLifecycle } from './daemon-endpoint-lifecycle'
import { DAEMON_ENDPOINT_LOST_MESSAGE } from './daemon-endpoint-ownership'
import type { DaemonFileLog } from './daemon-file-log'
import type {
  DaemonPtySpawnPreparations,
  PendingPtySpawnPreparation
} from './daemon-pty-spawn-preparations'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import type { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { TerminalHistorySeedTransferRegistry } from './terminal-history-seed-transfer-registry'
import type { CreateOrAttachResult, TerminalHost } from './terminal-host'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { isSpawnIntent } from '../../shared/host-spawn-admission'
import { parsePtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import {
  isAgentSessionExecutionClaim,
  isAgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import { type DaemonRequest, TerminalAttachCanceledError } from './types'
type CreateOrAttachRequest = Extract<DaemonRequest, { type: 'createOrAttach' }>

const MAX_SPAWN_ADMISSION_WINDOW_MS = 12_000

// Leave time for the paced spawn to finish before caller cancellation (15 seconds on remote clients).
function resolveSpawnAdmissionDeadline(cancelAfterMs: unknown): number {
  const windowMs =
    Number.isSafeInteger(cancelAfterMs) && Number(cancelAfterMs) > 0
      ? Math.min(Number(cancelAfterMs) / 2, MAX_SPAWN_ADMISSION_WINDOW_MS)
      : MAX_SPAWN_ADMISSION_WINDOW_MS
  return Date.now() + windowMs
}

export type DaemonTerminalAdmissionOptions = {
  host: TerminalHost
  connections: DaemonClientConnections
  endpoint: DaemonEndpointLifecycle
  preparations: DaemonPtySpawnPreparations
  attachments: DaemonSessionAttachments
  historySeedTransfers: TerminalHistorySeedTransferRegistry
  transientFactRelay: BackgroundTransientFactRelay
  streamDataBatcher: DaemonStreamDataBatcher
  log: DaemonFileLog
  isAcceptingWork: () => boolean
  requestEndpointRetirement: () => void
  reevaluateIdleShutdown: () => void
}

export class DaemonTerminalAdmission {
  private createOrAttachInFlight = 0

  constructor(private readonly options: DaemonTerminalAdmissionOptions) {}

  get inFlight(): number {
    return this.createOrAttachInFlight
  }

  async createOrAttach(clientId: string, request: CreateOrAttachRequest): Promise<unknown> {
    const client = this.options.connections.get(clientId)
    if (!this.options.isAcceptingWork()) {
      throw new Error('Daemon temporarily unavailable; reconnect')
    }
    if (!client?.authenticatedPairEstablished || client.streamSocket === null) {
      throw new Error('Daemon client connection is incomplete; reconnect')
    }
    const payload = request.payload
    const attachOnly = payload.attachOnly === true
    if (!attachOnly && this.options.endpoint.hasLostOwnership()) {
      this.options.requestEndpointRetirement()
      throw new Error(DAEMON_ENDPOINT_LOST_MESSAGE)
    }
    this.createOrAttachInFlight++
    let routedSessionId = payload.sessionId
    let result: CreateOrAttachResult
    let spawnPreparation: PendingPtySpawnPreparation | null = null
    try {
      if (
        payload.agentSessionEnsure !== undefined &&
        (!isAgentSessionExecutionClaim(payload.agentSessionEnsure.claim) ||
          !isAgentSessionSurfaceBinding(payload.agentSessionEnsure.surface))
      ) {
        throw new Error('agent_session_identity_required')
      }
      spawnPreparation = this.options.preparations.register(
        payload.sessionId,
        clientId,
        request.id,
        payload.cancelAfterMs
      )
      if (!attachOnly) {
        await this.options.preparations.prepareUnlessCanceled(payload.sessionId, spawnPreparation)
      }
      if (payload.historySeed !== undefined && payload.historySeedTransferId !== undefined) {
        throw new Error('Multiple terminal history seed sources')
      }
      const historySeedChunks =
        payload.historySeedTransferId !== undefined
          ? this.options.historySeedTransfers.take(clientId, payload.historySeedTransferId)
          : payload.historySeed !== undefined
            ? [payload.historySeed]
            : undefined
      result = await this.options.host.createOrAttach({
        sessionId: payload.sessionId,
        cols: payload.cols,
        rows: payload.rows,
        cwd: payload.cwd,
        env: payload.env,
        envToDelete: payload.envToDelete,
        command: payload.command,
        startupCommandDelivery: payload.startupCommandDelivery,
        ...(attachOnly ? { attachOnly: true } : {}),
        ...(isTuiAgent(payload.launchAgent) ? { launchAgent: payload.launchAgent } : {}),
        shellOverride: payload.shellOverride,
        terminalShellArgs: payload.terminalShellArgs,
        terminalWindowsWslDistro: payload.terminalWindowsWslDistro,
        terminalWindowsPowerShellImplementation: payload.terminalWindowsPowerShellImplementation,
        shellReadySupported: payload.shellReadySupported,
        historySeedChunks,
        startupIngress: parsePtyStartupIngressIntent(payload.startupIngress),
        ...(payload.shellReadyTimeoutMs !== undefined
          ? { shellReadyTimeoutMs: payload.shellReadyTimeoutMs }
          : {}),
        ...(payload.agentSessionEnsure ? { agentSessionEnsure: payload.agentSessionEnsure } : {}),
        spawnAdmission: {
          clientId,
          declaredIntent: isSpawnIntent(payload.spawnIntent) ? payload.spawnIntent : null,
          deadlineAt: resolveSpawnAdmissionDeadline(payload.cancelAfterMs)
        },
        isCanceled: () =>
          spawnPreparation !== null && this.options.preparations.isCanceled(spawnPreparation),
        cancelSignal: spawnPreparation.controller.signal,
        onSessionResolved: (sessionId) => {
          routedSessionId = sessionId
        },
        streamClient: createAdmissionStreamClient(this.options, clientId, () => routedSessionId)
      })
    } finally {
      if (spawnPreparation) {
        this.options.preparations.finish(payload.sessionId, spawnPreparation)
      }
      this.createOrAttachInFlight--
      this.options.reevaluateIdleShutdown()
    }

    routedSessionId = result.agentSessionEnsure?.owner.ptyId ?? payload.sessionId
    if (
      this.options.connections.get(clientId) !== client ||
      !client.authenticatedPairEstablished ||
      client.streamSocket === null
    ) {
      this.options.host.detach(routedSessionId, result.attachToken)
      throw new TerminalAttachCanceledError(routedSessionId)
    }
    this.options.attachments.attach(routedSessionId, clientId, result.attachToken)
    this.options.streamDataBatcher.refreshSessionDroppability(routedSessionId)
    if (this.options.transientFactRelay.isBackgrounded(routedSessionId)) {
      this.options.streamDataBatcher.enqueueControlEvent(clientId, routedSessionId, {
        type: 'event',
        event: 'sessionBackgroundMarker',
        sessionId: routedSessionId,
        payload: { background: true }
      })
    }
    this.options.log.log(result.isNew ? 'session-created' : 'session-attached', {
      sessionId: routedSessionId,
      pid: result.pid
    })
    return {
      isNew: result.isNew,
      snapshot: result.snapshot,
      pid: result.pid,
      shellState: result.shellState,
      incarnationId: result.incarnationId,
      ...(result.launchAgent ? { launchAgent: result.launchAgent } : {}),
      wslDistro: result.wslDistro,
      ...(result.historySeeded !== undefined ? { historySeeded: result.historySeeded } : {}),
      ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {}),
      ...(result.cwdReadableByDaemon !== undefined
        ? { cwdReadableByDaemon: result.cwdReadableByDaemon }
        : {}),
      ...(result.inputClosed ? { inputClosed: true as const } : {})
    }
  }
}
