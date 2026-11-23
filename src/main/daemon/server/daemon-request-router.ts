import { parseDaemonLaunchNoteChange } from '../protocol/daemon-launch-note-protocol'
import { handleDaemonTerminalKill } from './daemon-terminal-kill'
import { answerShutdown, answerShutdownIfIdle } from './daemon-shutdown-requests'
import { handleDaemonFencedTermination } from './daemon-fenced-termination'
import { performance } from 'node:perf_hooks'
import { setPtyOwnerHostColors } from '../../../shared/terminal/pty/ingress/pty-owner-color-query-colors'
import type { ConnectedDaemonClient, DaemonClientConnections } from './daemon-client-connections'
import type { DaemonFileLog } from '../observability/daemon-file-log'
import type { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'
import type { DaemonServerLifecycle } from './daemon-server-lifecycle'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import type { DaemonSessionBackgroundRouting } from './daemon-session-background-routing'
import { recordDaemonStreamBacklogEvent } from '../transport/stream/daemon-stream-backlog-probe'
import type { DaemonStreamDataBatcher } from '../transport/stream/daemon-stream-data-batcher'
import type { DaemonTerminalAdmission } from './daemon-terminal-admission'
import { DaemonHealthRequests } from '../health/daemon-health-requests'
import type { TerminalHistorySeedTransferRegistry } from '../history/seed-transfer/terminal-history-seed-transfer-registry'
import type { TerminalHost } from '../terminal-host/terminal-host'
import type { ProviderRelayHost } from '../provider-relay/provider-relay-host'
import { SessionNotFoundError } from '../protocol/daemon-errors'
import { HOST_LOST_EXIT_CAUSE } from '../../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import type { DaemonRequest, GetSnapshotRequest } from '../protocol/daemon-rpc-contract'

export type DaemonRequestRouterOptions = {
  host: TerminalHost
  connections: DaemonClientConnections
  lifecycle: DaemonServerLifecycle
  admission: DaemonTerminalAdmission
  preparations: DaemonPtySpawnPreparations
  attachments: DaemonSessionAttachments
  historySeedTransfers: TerminalHistorySeedTransferRegistry
  sessionBackgroundRouting: DaemonSessionBackgroundRouting
  streamDataBatcher: DaemonStreamDataBatcher
  ptySpawnHealthCheck: () => Promise<void>
  log: DaemonFileLog
  relays: ProviderRelayHost
}

export class DaemonRequestRouter {
  private readonly health: DaemonHealthRequests

  constructor(private readonly options: DaemonRequestRouterOptions) {
    this.health = new DaemonHealthRequests(options.ptySpawnHealthCheck, options.log)
  }

  async route(clientId: string, request: DaemonRequest): Promise<unknown> {
    const client = this.options.connections.get(clientId)
    switch (request.type) {
      case 'probeProviderCwd':
      case 'spawnProvider':
        throw new Error('Provider requests are answered before routing')
      case 'startHistorySeedTransfer': {
        if (!client?.authenticatedPairEstablished || client.streamSocket === null) {
          throw new Error('Daemon client connection is incomplete; reconnect')
        }
        return {
          transferId: this.options.historySeedTransfers.start(clientId, request.payload)
        }
      }
      case 'appendHistorySeedTransfer':
        this.options.historySeedTransfers.append(
          clientId,
          request.payload.transferId,
          request.payload.index,
          request.payload.data
        )
        return {}
      case 'finishHistorySeedTransfer':
        this.options.historySeedTransfers.finish(clientId, request.payload.transferId)
        return {}
      case 'abortHistorySeedTransfer':
        this.options.historySeedTransfers.abort(clientId, request.payload.transferId)
        return {}
      case 'createOrAttach':
        return this.options.admission.createOrAttach(clientId, request)
      case 'cancelCreateOrAttach':
        return {
          canceled: this.options.preparations.cancel(request.payload.sessionId, {
            clientId,
            ...(typeof request.payload.requestId === 'string'
              ? { requestId: request.payload.requestId }
              : {})
          })
        }
      case 'closeStartupQueryAuthority':
        return {
          appliedSeq: this.options.host.closeStartupQueryAuthority(request.payload.sessionId)
        }
      case 'setColorQueryReplyColors':
        setPtyOwnerHostColors(request.payload.colors)
        return {}
      case 'write':
        return this.write(client, request.payload.sessionId, request.payload.data)
      case 'resize':
        return this.resize(
          client,
          request.payload.sessionId,
          request.payload.cols,
          request.payload.rows
        )
      case 'pausePty':
        this.options.host.pauseProducer(request.payload.sessionId)
        return {}
      case 'resumePty':
        this.options.host.resumeProducer(request.payload.sessionId)
        return {}
      case 'setSessionBackground':
        return this.options.sessionBackgroundRouting.setBackground(
          request.payload.sessionId,
          request.payload.background === true
        )
      case 'kill':
        if (
          request.payload.expectedIncarnationId !== undefined ||
          request.payload.requireNoAgentOwner !== undefined ||
          request.payload.requireUnattached !== undefined
        ) {
          return handleDaemonFencedTermination(request.payload, this.options)
        }
        return handleDaemonTerminalKill(clientId, request.payload, this.options)
      case 'signal':
        this.options.host.signal(request.payload.sessionId, request.payload.signal)
        return {}
      case 'detach':
        this.options.attachments.detachSessionForClient(request.payload.sessionId, clientId)
        this.options.log.log('session-detached', { sessionId: request.payload.sessionId })
        return {}
      case 'getCwd':
        return { cwd: await this.options.host.getCwd(request.payload.sessionId) }
      case 'getForegroundProcess':
        return {
          foregroundProcess: this.options.host.getForegroundProcess(request.payload.sessionId)
        }
      case 'inspectProcess': {
        const options = {
          ...(request.payload.foregroundOnly === true ? { foregroundOnly: true } : {}),
          ...(request.payload.expectedIncarnationId
            ? { expectedIncarnationId: request.payload.expectedIncarnationId }
            : {}),
          ...(request.payload.steadyState === true ? { steadyState: true } : {}),
          ...(request.payload.jobMembershipOnly === true ? { jobMembershipOnly: true } : {}),
          ...(request.payload.ignoreDetached === true ? { ignoreDetached: true } : {})
        }
        return Object.keys(options).length > 0
          ? this.options.host.inspectProcess(request.payload.sessionId, options)
          : this.options.host.inspectProcess(request.payload.sessionId)
      }
      case 'confirmForegroundProcess':
        return {
          foregroundProcess: await this.options.host.confirmForegroundProcess(
            request.payload.sessionId
          )
        }
      case 'confirmShellForeground':
        return {
          confirmed: await this.options.host.confirmShellForeground(request.payload.sessionId)
        }
      case 'setLaunchNote': {
        const change = parseDaemonLaunchNoteChange(request.payload.change)
        if (change) {
          this.options.host.setLaunchNote(request.payload.sessionId, change)
        }
        return {}
      }
      case 'clearScrollback':
        this.options.host.clearScrollback(request.payload.sessionId)
        return {}
      case 'resetInputModes':
        this.options.host.resetInputModes(request.payload.sessionId)
        return {}
      case 'reportFocusLost':
      case 'requestRepaint':
        this.options.host[request.type](request.payload.sessionId)
        return {}
      case 'listSessions':
        return {
          sessions: this.options.host.listSessions(),
          liveRelays: this.options.relays.liveCount,
          runningRelays: this.options.relays.runningCount
        }
      case 'shutdownIfIdle':
        return answerShutdownIfIdle(this.options, clientId, request.id)
      case 'getSnapshot':
        return this.getSnapshot(request.payload)
      case 'getSize':
        return { size: this.options.host.getAppliedSize(request.payload.sessionId) }
      case 'takePendingOutput':
        return this.options.host.takePendingOutput(
          request.payload.sessionId,
          request.payload.includeSnapshot === true,
          { teardownSnapshot: request.payload.teardownSnapshot === true }
        )
      case 'ping':
      case 'systemResolverHealth':
      case 'fullDiskAccessStatus':
      case 'ptySpawnHealth':
      case 'asyncIoHealth':
        return this.health.handle(request)
      case 'shutdown':
        return answerShutdown(this.options, clientId, request.id, request.payload.killSessions)
    }
    throw new Error(`Unknown request type: ${(request as { type: string }).type}`)
  }

  private write(
    client: ConnectedDaemonClient | undefined,
    sessionId: string,
    data: string
  ): Record<string, never> {
    try {
      this.options.attachments.recordInput(sessionId)
      this.options.host.write(sessionId, data)
    } catch (error) {
      this.options.attachments.clearInput(sessionId)
      if (error instanceof SessionNotFoundError) {
        this.sendSessionLostEvent(client, sessionId)
      }
      throw error
    }
    return {}
  }

  private resize(
    client: ConnectedDaemonClient | undefined,
    sessionId: string,
    cols: number,
    rows: number
  ): Record<string, never> {
    try {
      this.options.host.resize(sessionId, cols, rows)
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        this.sendSessionLostEvent(client, sessionId)
      }
      throw error
    }
    return {}
  }

  private async getSnapshot({ sessionId: id, ...opts }: GetSnapshotRequest['payload']) {
    const startedAt = performance.now()
    const scrollbackRows =
      typeof opts.scrollbackRows === 'number' && Number.isFinite(opts.scrollbackRows)
        ? Math.max(0, Math.min(50_000, Math.floor(opts.scrollbackRows)))
        : undefined
    const snapshot = await this.options.host.getSettledSnapshot(id, { ...opts, scrollbackRows })
    const snapshotMs = performance.now() - startedAt
    if (snapshotMs >= 25) {
      recordDaemonStreamBacklogEvent('slowGetSnapshot', {
        sessionIdSuffix: id.slice(-10),
        snapshotMs: Math.round(snapshotMs)
      })
    }
    return { snapshot }
  }

  /** The client wrote to a session this host no longer has: nobody asked it to stop. */
  private sendSessionLostEvent(client: ConnectedDaemonClient | undefined, sessionId: string): void {
    if (!client?.streamSocket) {
      return
    }
    this.options.streamDataBatcher.enqueueControlEvent(client.clientId, sessionId, {
      type: 'event',
      event: 'exit',
      sessionId,
      payload: { code: -1, cause: HOST_LOST_EXIT_CAUSE }
    })
    this.options.streamDataBatcher.flush(client.clientId)
  }
}
