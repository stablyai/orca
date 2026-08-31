import { performance } from 'node:perf_hooks'
import { readCurrentProcessMacSystemResolverHealth } from '../network/macos-system-resolver-health'
import type { ConnectedDaemonClient, DaemonClientConnections } from './daemon-client-connections'
import type { DaemonFileLog } from './daemon-file-log'
import type { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'
import type { DaemonServerLifecycle } from './daemon-server-lifecycle'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import type { DaemonSessionBackgroundRouting } from './daemon-session-background-routing'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import type { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { DaemonTerminalAdmission } from './daemon-terminal-admission'
import type { TerminalHistorySeedTransferRegistry } from './terminal-history-seed-transfer-registry'
import type { TerminalHost } from './terminal-host'
import { SessionNotFoundError, type DaemonRequest } from './types'

type DaemonRequestRouterOptions = {
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
}

export class DaemonRequestRouter {
  constructor(private readonly options: DaemonRequestRouterOptions) {}

  async route(clientId: string, request: DaemonRequest): Promise<unknown> {
    const client = this.options.connections.get(clientId)
    switch (request.type) {
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
        return this.kill(clientId, request.payload.sessionId, request.payload.immediate)
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
      case 'inspectProcess':
        return this.options.host.inspectProcess(request.payload.sessionId)
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
      case 'clearScrollback':
        this.options.host.clearScrollback(request.payload.sessionId)
        return {}
      case 'listSessions':
        return { sessions: this.options.host.listSessions() }
      case 'shutdownIfIdle':
        return this.shutdownIfIdle(clientId, request.id)
      case 'getSnapshot':
        return this.getSnapshot(request.payload.sessionId, request.payload.scrollbackRows)
      case 'getSize':
        return { size: this.options.host.getAppliedSize(request.payload.sessionId) }
      case 'takePendingOutput':
        return this.options.host.takePendingOutput(
          request.payload.sessionId,
          request.payload.includeSnapshot === true,
          { teardownSnapshot: request.payload.teardownSnapshot === true }
        )
      case 'ping':
        return { pong: true }
      case 'systemResolverHealth':
        return { health: await readCurrentProcessMacSystemResolverHealth() }
      case 'ptySpawnHealth':
        await this.options.ptySpawnHealthCheck()
        return { healthy: true }
      case 'shutdown':
        return this.shutdown(clientId, request.id, request.payload.killSessions)
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
        this.sendExitEvent(client, sessionId, -1)
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
        this.sendExitEvent(client, sessionId, -1)
      }
      throw error
    }
    return {}
  }

  private async kill(
    clientId: string,
    sessionId: string,
    immediate: boolean | undefined
  ): Promise<Record<string, never>> {
    const canceledPendingSpawn = this.options.preparations.cancel(sessionId)
    this.options.attachments.clearInput(sessionId)
    const attribution = { sessionId, immediate: immediate === true, clientId }
    try {
      await this.options.host.kill(sessionId, { immediate })
    } catch (error) {
      if (!(canceledPendingSpawn && error instanceof SessionNotFoundError)) {
        this.options.log.log('session-kill-failed', attribution)
        throw error
      }
    }
    this.options.log.log('session-killed', attribution)
    return {}
  }

  private shutdownIfIdle(clientId: string, requestId: string): { retiring: boolean } {
    const client = this.options.connections.get(clientId)
    const retiring =
      client !== undefined &&
      client.streamSocket !== null &&
      this.options.connections.size === 1 &&
      this.options.admission.inFlight === 0 &&
      this.options.host.listSessions().length === 0 &&
      this.options.connections.hasOnlyTransportsFor(client)
    if (retiring) {
      this.options.lifecycle.retireAfterIdleReply(clientId, requestId, client.controlSocket)
    }
    return { retiring }
  }

  private async getSnapshot(sessionId: string, requestedRows: unknown): Promise<unknown> {
    const startedAt = performance.now()
    const scrollbackRows =
      typeof requestedRows === 'number' && Number.isFinite(requestedRows)
        ? Math.max(0, Math.min(50_000, Math.floor(requestedRows)))
        : undefined
    const snapshot = await this.options.host.getSettledSnapshot(sessionId, { scrollbackRows })
    const snapshotMs = performance.now() - startedAt
    if (snapshotMs >= 25) {
      recordDaemonStreamBacklogEvent('slowGetSnapshot', {
        sessionIdSuffix: sessionId.slice(-10),
        snapshotMs: Math.round(snapshotMs)
      })
    }
    return { snapshot }
  }

  private async shutdown(
    clientId: string,
    requestId: string,
    killSessions: boolean
  ): Promise<Record<string, never>> {
    this.options.log.log('shutdown', {
      reason: 'rpc',
      killSessions: killSessions === true
    })
    const serverClose = this.options.lifecycle.beginOrdinaryShutdownFence()
    if (killSessions) {
      try {
        await this.options.host.dispose()
      } catch (error) {
        this.options.log.log('shutdown-dispose-failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    const controlSocket = this.options.connections.get(clientId)?.controlSocket
    if (controlSocket) {
      this.options.lifecycle.deferRpcShutdownUntilReply(
        clientId,
        requestId,
        controlSocket,
        serverClose
      )
    } else {
      this.options.lifecycle.finishRpcShutdownWithoutReply(serverClose)
    }
    return {}
  }

  private sendExitEvent(
    client: ConnectedDaemonClient | undefined,
    sessionId: string,
    code: number
  ): void {
    if (!client?.streamSocket) {
      return
    }
    this.options.streamDataBatcher.enqueueControlEvent(client.clientId, sessionId, {
      type: 'event',
      event: 'exit',
      sessionId,
      payload: { code }
    })
    this.options.streamDataBatcher.flush(client.clientId)
  }
}
