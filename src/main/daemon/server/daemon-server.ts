import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { setImmediate as waitForImmediate } from 'node:timers/promises'
import { DaemonClientConnections } from './daemon-client-connections'
import { createDaemonSessionStreams } from './daemon-session-streams'
import type { BackgroundTransientFactRelay } from '../transport/stream/daemon-background-transient-facts'
import type { DaemonStreamDataBatcher } from '../transport/stream/daemon-stream-data-batcher'
import { DaemonEndpointLifecycle } from '../endpoint/publication/daemon-endpoint-lifecycle'
import { createNoopDaemonFileLog, type DaemonFileLog } from '../observability/daemon-file-log'
import { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'
import { DaemonRequestRouter } from './daemon-request-router'
import { answerProviderRequest } from './daemon-provider-requests'
import type { ProviderRelayHost } from '../provider-relay/provider-relay-host'
import { answerProviderRelayRequest } from '../provider-relay/provider-relay-requests'
import { createDaemonProviderRelays } from '../provider-relay/daemon-provider-relays'
import { DaemonServerLifecycle } from './daemon-server-lifecycle'
import type { DaemonServerOptions } from './daemon-server-options'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import { DaemonSessionBackgroundRouting } from './daemon-session-background-routing'
import {
  daemonClientBacklogSampler,
  startDaemonStreamBacklogProbe
} from '../transport/stream/daemon-stream-backlog-probe'
import { DaemonTerminalAdmission } from './daemon-terminal-admission'
import { checkPtySpawnHealth } from '../pty-subprocess/pty-subprocess'
import { TerminalHistorySeedTransferRegistry } from '../history/seed-transfer/terminal-history-seed-transfer-registry'
import { TerminalHost } from '../terminal-host/terminal-host'
import { DaemonAutomaticWorkGuard } from '../admission/daemon-automatic-work-guard'
import { answerAutomaticWorkRequest } from '../admission/daemon-automatic-work-protocol'
import { HostTerminalPolicy } from '../admission/host-terminal-policy'
import { answerTerminalLimitRequest } from './daemon-terminal-limit-protocol'
import {
  CLEAN_DISCONNECT_PROTOCOL_VERSION,
  PROTOCOL_VERSION
} from '../protocol/daemon-protocol-version'
import type { DaemonRequest } from '../protocol/daemon-rpc-contract'
import { sendDaemonTransientFact } from './daemon-transient-fact-delivery'
import { answerDaemonControlRequest } from './daemon-control-request'

export class DaemonServer {
  private static readonly INITIAL_ADOPTION_TIMEOUT_MS = 2 * 60 * 1000

  private readonly log: DaemonFileLog
  readonly automaticWork: DaemonAutomaticWorkGuard
  readonly host: TerminalHost
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
  private readonly providerWork: Parameters<typeof answerProviderRequest>[3]
  private readonly relays: ProviderRelayHost
  private stopStreamBacklogProbe: () => void = () => {}
  private readonly terminalPolicy: HostTerminalPolicy
  private terminalPolicyNonce = ''

  constructor(options: DaemonServerOptions) {
    this.log = options.log ?? createNoopDaemonFileLog()
    this.terminalPolicy = options.terminalLimitPolicy ?? new HostTerminalPolicy()
    this.automaticWork = new DaemonAutomaticWorkGuard({
      markerPath: options.automaticWorkMarkerPath,
      hostTerminalLedgerDir: options.hostTerminalLedgerDir,
      terminalPolicy: this.terminalPolicy,
      mode: options.spawnAdmission ?? 'observe',
      log: this.log,
      listSessions: () => this.host.listSessions(),
      ownsEndpoint: () => !this.endpoint.lost
    })
    this.host = new TerminalHost({
      spawnSubprocess: options.spawnSubprocess,
      spawnGate: this.automaticWork.gate,
      reportReadinessEvent: (event, details) => this.log.log(event, details),
      onSessionReaped: (sessionId) => {
        this.attachments.release(sessionId)
        this.transientFactRelay.onSessionExit(sessionId)
        this.streamDataBatcher.refreshSessionDroppability(sessionId)
        options.onPtySessionExit?.(sessionId)
        this.lifecycle.reevaluateIdleShutdown()
      },
      onSessionForegroundChange: (sessionId) =>
        sendDaemonTransientFact(this.attachments, this.streamDataBatcher, sessionId, {
          kind: 'foreground-changed'
        })
    })
    const streams = createDaemonSessionStreams({
      host: this.host,
      connections: () => this.connections,
      log: this.log
    })
    this.attachments = streams.attachments
    this.transientFactRelay = streams.transientFactRelay
    this.streamDataBatcher = streams.streamDataBatcher
    this.preparations = new DaemonPtySpawnPreparations(
      options.preparePtySpawn ?? (() => Promise.resolve())
    )

    const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION
    const hasIdentity = protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION
    const launchNonce = options.launchNonce ?? (hasIdentity ? randomUUID() : null)
    const startedAtMs =
      options.startedAtMs ?? (hasIdentity ? Date.now() - process.uptime() * 1000 : null)
    this.terminalPolicyNonce = launchNonce ?? randomUUID()
    const token = randomUUID()

    this.providerWork = {
      providerSpawn: options.providerSpawn === true,
      acceptsProviderWork: () =>
        this.lifecycle.isAcceptingWork() && !this.endpoint.hasLostOwnership()
    }
    const relays = createDaemonProviderRelays({
      ...options,
      protocolVersion,
      daemonInstance: launchNonce,
      acceptsWork: this.providerWork.acceptsProviderWork,
      onLiveCountChanged: () => this.lifecycle.reevaluateIdleShutdown(),
      log: this.log
    })
    this.relays = relays.relays
    this.connections = new DaemonClientConnections({
      token,
      protocolVersion,
      identity: {
        launchNonce,
        startedAtMs,
        entryPath: options.entryPath ?? null,
        appVersion: options.appVersion ?? null,
        spawnerExecPath: options.spawnerExecPath ?? null,
        ...(this.providerWork.providerSpawn ? { providerSpawn: true as const } : {}),
        ...relays.identity
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
      onControlRequest: (socket, clientId, request) => {
        // Unhandled request rejections are fatal to the daemon.
        this.handleRequest(socket, clientId, request).catch((error: unknown) => {
          this.log.log('client-request-failed', {
            error: error instanceof Error ? error.message : String(error)
          })
        })
      },
      onControlReplaced: (clientId) => {
        this.preparations.cancelForClient(clientId)
        this.historySeedTransfers.clearOwner(clientId)
        this.streamDataBatcher.clear(clientId)
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
      setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs).unref(),
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
      onRpcShutdown: options.onRpcShutdown ?? (() => {}),
      onShutdownRequested: options.onShutdownRequested ?? (() => {})
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
      reevaluateIdleShutdown: () => this.lifecycle.reevaluateIdleShutdown(),
      hostTerminalUsage: () => this.automaticWork.gate.hostTerminalUsage()
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
      log: this.log,
      relays: this.relays
    })
    this.stopStreamBacklogProbe = startDaemonStreamBacklogProbe(
      daemonClientBacklogSampler(this.connections, this.streamDataBatcher, this.transientFactRelay)
    )
  }

  async start(): Promise<void> {
    await this.terminalPolicy.start((event, details) => this.log.log(event, details))
    if (!this.lifecycle.isAcceptingWork()) {
      return
    }
    try {
      await this.lifecycle.start((socket) => this.connections.accept(socket))
    } catch (error) {
      this.terminalPolicy.dispose()
      throw error
    }
    // Only the endpoint winner may inspect or rewrite the automatic-work marker.
    this.automaticWork.start()
  }

  shutdown(): Promise<void> {
    return this.lifecycle.shutdown()
  }

  private isIdle(): boolean {
    const noClients = this.connections.transportCount === 0 && this.connections.size === 0
    return (
      this.admission.inFlight === 0 &&
      !this.host.hasLiveSessions() &&
      this.relays.liveCount === 0 &&
      (this.endpoint.lost || noClients)
    )
  }

  private async disposeResources(): Promise<void> {
    this.terminalPolicy.dispose()
    this.endpoint.stopOwnershipWatch()
    this.stopStreamBacklogProbe()
    this.transientFactRelay.dispose()
    this.preparations.cancelAll()
    // Both finish before shutdown goes on, even when one of them fails.
    const disposed = await Promise.allSettled([this.host.dispose(), this.relays.dispose()])
    const failure = disposed.find((result) => result.status === 'rejected')
    if (failure) {
      const error: unknown = failure.reason
      this.log.log('shutdown-dispose-failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
    this.streamDataBatcher.clear()
    this.historySeedTransfers.dispose()
    // Clearing earlier could make a crash during PTY teardown look like orderly shutdown.
    this.automaticWork.stop()
    // Let canceled in-flight RPCs enqueue their protocol errors before transport destruction.
    await waitForImmediate()
    this.connections.dispose()
  }

  private async handleRequest(
    socket: Socket,
    clientId: string,
    request: DaemonRequest
  ): Promise<void> {
    return answerDaemonControlRequest(
      socket,
      request,
      async () =>
        answerTerminalLimitRequest(
          request,
          this.terminalPolicy,
          this.terminalPolicyNonce,
          this.providerWork.acceptsProviderWork
        ) ??
        answerProviderRequest(request, this.connections.get(clientId), socket, this.providerWork) ??
        answerProviderRelayRequest(request, this.connections.get(clientId), socket, this.relays) ??
        answerAutomaticWorkRequest(request, this.automaticWork, this.endpoint) ??
        this.requestRouter.route(clientId, request),
      () => this.lifecycle.startPendingShutdownReply(clientId, request.id)
    )
  }
}
