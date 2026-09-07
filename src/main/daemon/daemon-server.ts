import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { setImmediate as waitForImmediate } from 'node:timers/promises'
import { extractHiddenStartupRendererQueryData } from '../../shared/terminal-reply-query-extraction'
import {
  BackgroundTransientFactRelay,
  BACKGROUND_STREAM_DROP_ENABLED
} from './daemon-background-transient-facts'
import { DaemonClientConnections } from './daemon-client-connections'
import { DaemonEndpointLifecycle } from './daemon-endpoint-lifecycle'
import { createNoopDaemonFileLog, type DaemonFileLog } from './daemon-file-log'
import { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'
import { DaemonRequestRouter } from './daemon-request-router'
import { DaemonServerLifecycle } from './daemon-server-lifecycle'
import type { DaemonServerOptions } from './daemon-server-options'
import { DaemonSessionAttachments } from './daemon-session-attachments'
import { DaemonSessionBackgroundRouting } from './daemon-session-background-routing'
import { startDaemonStreamBacklogProbe } from './daemon-stream-backlog-probe'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { DaemonTerminalAdmission } from './daemon-terminal-admission'
import { checkPtySpawnHealth } from './pty-subprocess'
import { TerminalHistorySeedTransferRegistry } from './terminal-history-seed-transfer-registry'
import { TerminalHost } from './terminal-host'
import {
  CLEAN_DISCONNECT_PROTOCOL_VERSION,
  NOTIFY_PREFIX,
  PROTOCOL_VERSION,
  type DaemonRequest
} from './types'
import { encodeNdjson } from './ndjson'

export class DaemonServer {
  private static readonly INITIAL_ADOPTION_TIMEOUT_MS = 2 * 60 * 1000

  private readonly log: DaemonFileLog
  private readonly host: TerminalHost
  private readonly transientFactRelay: BackgroundTransientFactRelay
  private readonly streamDataBatcher: DaemonStreamDataBatcher
  private readonly attachments: DaemonSessionAttachments
  private readonly historySeedTransfers = new TerminalHistorySeedTransferRegistry()
  private readonly preparations: DaemonPtySpawnPreparations
  private readonly connections: DaemonClientConnections
  private readonly endpoint: DaemonEndpointLifecycle
  private readonly lifecycle: DaemonServerLifecycle
  private readonly admission: DaemonTerminalAdmission
  private readonly requestRouter: DaemonRequestRouter
  private stopStreamBacklogProbe: () => void = () => {}

  constructor(options: DaemonServerOptions) {
    this.log = options.log ?? createNoopDaemonFileLog()
    this.host = new TerminalHost({
      spawnSubprocess: options.spawnSubprocess,
      reportReadinessEvent: (event, details) => this.log.log(event, details),
      onSessionReaped: (sessionId) => {
        this.attachments.release(sessionId)
        this.transientFactRelay.onSessionExit(sessionId)
        this.streamDataBatcher.refreshSessionDroppability(sessionId)
        options.onPtySessionExit?.(sessionId)
        this.lifecycle.reevaluateIdleShutdown()
      }
    })
    this.attachments = new DaemonSessionAttachments(this.host)
    this.transientFactRelay = new BackgroundTransientFactRelay((sessionId, fact) => {
      const clientId = this.attachments.clientIdForSession(sessionId)
      if (clientId) {
        this.streamDataBatcher.enqueueControlEvent(clientId, sessionId, {
          type: 'event',
          event: 'transientFact',
          sessionId,
          payload: fact
        })
      }
    })
    this.streamDataBatcher = new DaemonStreamDataBatcher(
      (clientId) => this.connections.get(clientId),
      {
        isSessionDroppable: (sessionId) =>
          BACKGROUND_STREAM_DROP_ENABLED && this.transientFactRelay.isBackgrounded(sessionId),
        salvageDroppedData: (dropped) => {
          if (!dropped.includes('\x1b')) {
            return ''
          }
          const extracted = extractHiddenStartupRendererQueryData(dropped, '')
          return (
            extracted.statelessQueryData + extracted.statefulQueryData + extracted.oscColorQueryData
          )
        }
      }
    )
    this.preparations = new DaemonPtySpawnPreparations(
      options.preparePtySpawn ?? (() => Promise.resolve())
    )

    const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION
    const launchNonce =
      options.launchNonce ??
      (protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION ? randomUUID() : null)
    const startedAtMs =
      options.startedAtMs ??
      (protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION
        ? Date.now() - process.uptime() * 1000
        : null)
    const token = randomUUID()

    this.connections = new DaemonClientConnections({
      token,
      protocolVersion,
      identity: {
        launchNonce,
        startedAtMs,
        entryPath: options.entryPath ?? null,
        appVersion: options.appVersion ?? null,
        spawnerExecPath: options.spawnerExecPath ?? null
      },
      log: this.log,
      streamDataBatcher: this.streamDataBatcher,
      isAcceptingWork: () => this.lifecycle.isAcceptingWork(),
      onTransportChanged: () => this.lifecycle.reevaluateIdleShutdown(),
      onConnectionAccepted: () => this.lifecycle.onConnectionAccepted(),
      onAuthenticatedPair: () => {
        options.onAuthenticatedClientPair?.()
        this.lifecycle.onAuthenticatedPair()
      },
      onLastAuthenticatedClientDisconnected: () =>
        this.lifecycle.onLastAuthenticatedClientDisconnected(),
      onControlRequest: (socket, clientId, request) =>
        void this.handleRequest(socket, clientId, request),
      onControlReplaced: (clientId) => {
        this.preparations.cancelForClient(clientId)
        this.historySeedTransfers.clearOwner(clientId)
      },
      onClientDisconnected: (clientId) => {
        this.preparations.cancelForClient(clientId)
        this.historySeedTransfers.clearOwner(clientId)
        this.streamDataBatcher.clear(clientId)
        this.attachments.detachClientSessions(clientId)
      },
      onStreamDisconnected: (clientId) => {
        this.preparations.cancelForClient(clientId)
        this.streamDataBatcher.clear(clientId)
        this.attachments.detachClientSessions(clientId)
      }
    })
    this.endpoint = new DaemonEndpointLifecycle({
      socketPath: options.socketPath,
      tokenPath: options.tokenPath,
      pidPath: options.pidPath ?? null,
      launchNonce,
      token,
      publishEndpointOwnership: options.publishEndpointOwnership ?? (() => {}),
      log: this.log,
      isServing: () => this.lifecycle.isAcceptingWork(),
      onOwnershipLost: () => this.lifecycle.onEndpointOwnershipLost()
    })
    const lifecycleClock = options.initialAdoptionTestConfig?.clock ?? {
      setTimeout: (callback: () => void, delayMs: number) => {
        const timer = setTimeout(callback, delayMs)
        timer.unref()
        return timer
      },
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now()
    }
    this.lifecycle = new DaemonServerLifecycle({
      protocolVersion,
      initialAdoptionTimeoutMs:
        options.initialAdoptionTestConfig?.timeoutMs ?? DaemonServer.INITIAL_ADOPTION_TIMEOUT_MS,
      clock: lifecycleClock,
      endpoint: this.endpoint,
      log: this.log,
      isIdle: () => this.isIdle(),
      disposeResources: () => this.disposeResources(),
      onIdleShutdown: options.onIdleShutdown ?? (() => {}),
      onRpcShutdown: options.onRpcShutdown ?? (() => {})
    })
    this.admission = new DaemonTerminalAdmission({
      host: this.host,
      connections: this.connections,
      endpoint: this.endpoint,
      preparations: this.preparations,
      attachments: this.attachments,
      historySeedTransfers: this.historySeedTransfers,
      transientFactRelay: this.transientFactRelay,
      streamDataBatcher: this.streamDataBatcher,
      log: this.log,
      isAcceptingWork: () => this.lifecycle.isAcceptingWork(),
      requestEndpointRetirement: () => this.endpoint.requestRetirementForLoss(),
      reevaluateIdleShutdown: () => this.lifecycle.reevaluateIdleShutdown()
    })
    this.requestRouter = new DaemonRequestRouter({
      host: this.host,
      connections: this.connections,
      lifecycle: this.lifecycle,
      admission: this.admission,
      preparations: this.preparations,
      attachments: this.attachments,
      historySeedTransfers: this.historySeedTransfers,
      sessionBackgroundRouting: new DaemonSessionBackgroundRouting({
        host: this.host,
        attachments: this.attachments,
        transientFactRelay: this.transientFactRelay,
        streamDataBatcher: this.streamDataBatcher
      }),
      streamDataBatcher: this.streamDataBatcher,
      ptySpawnHealthCheck: options.ptySpawnHealthCheck ?? checkPtySpawnHealth,
      log: this.log
    })
    this.stopStreamBacklogProbe = startDaemonStreamBacklogProbe(() => ({
      clients: Array.from(this.connections.values(), (client) => ({
        clientId: client.clientId,
        socketBufferedBytes: client.streamSocket?.writableLength ?? 0,
        batcherQueuedChars: this.streamDataBatcher.queuedCharsForClient(client.clientId)
      })),
      backgroundedSessionIdSuffixes: this.transientFactRelay.backgroundedSessionIdSuffixes()
    }))
  }

  start(): Promise<void> {
    return this.lifecycle.start((socket) => this.connections.accept(socket))
  }

  shutdown(): Promise<void> {
    return this.lifecycle.shutdown()
  }

  private isIdle(): boolean {
    if (this.admission.inFlight > 0 || this.host.listSessions().length > 0) {
      return false
    }
    if (this.endpoint.lost) {
      return true
    }
    return this.connections.transportCount === 0 && this.connections.size === 0
  }

  private async disposeResources(): Promise<void> {
    this.endpoint.stopOwnershipWatch()
    this.stopStreamBacklogProbe()
    this.transientFactRelay.dispose()
    this.preparations.cancelAll()
    try {
      await this.host.dispose()
    } catch (error) {
      this.log.log('shutdown-dispose-failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
    this.streamDataBatcher.clear()
    this.historySeedTransfers.dispose()
    // Let canceled in-flight RPCs enqueue their protocol errors before transport destruction.
    await waitForImmediate()
    this.connections.dispose()
  }

  private async handleRequest(
    socket: Socket,
    clientId: string,
    request: DaemonRequest
  ): Promise<void> {
    const isNotify = request.id.startsWith(NOTIFY_PREFIX)
    try {
      const result = await this.requestRouter.route(clientId, request)
      if (!isNotify) {
        socket.write(encodeNdjson({ id: request.id, ok: true, payload: result }), () => {
          this.lifecycle.startPendingShutdownReply(clientId, request.id)
        })
      }
    } catch (error) {
      if (!isNotify) {
        socket.write(
          encodeNdjson({
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        )
      }
    }
  }
}
