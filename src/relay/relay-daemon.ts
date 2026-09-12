import { installRelayLogRotation } from './rotating-log-writer'
import { randomUUID } from 'node:crypto'
import { RelayNetworkTunnelRegistry } from './relay-network-tunnel-registry'
import { registerRelayNetworkTunnels } from './relay-network-tunnel-registration'
import { readLaunchVersion } from './relay-handshake'
import type { RelayLaunchOptions } from './relay-launch-options'
import { RELAY_EMPTY_DETACHED_STARTUP_GRACE_MS, RELAY_IDLE_GRACE_MS } from './relay-launch-options'
import { relayLogLine } from './relay-diagnostic-log'
import { RelayPrimaryChannel } from './relay-primary-channel'
import { RelayRuntimeServices } from './relay-runtime-services'
import { RelayAgentHookRuntime } from './relay-agent-hook-runtime'
import { RelaySocketOwnership } from './relay-socket-ownership'
import { RelayReconnectListener } from './relay-reconnect-listener'
import { RelayGraceLifecycle } from './relay-grace-lifecycle'
import { registerRelayOwnerReset } from './relay-owner-reset-registration'
import { RelayOwnerResetPreparationJournal } from './relay-owner-reset-preparation-journal'
import {
  publishRelayEndpointCredential,
  restrictWindowsRelayEndpointCredential
} from './relay-endpoint-credential-publication'
import { SKILL_RELAY_CAPABILITIES } from './skill-install-handler'
import { endpointDirForRelaySocket } from './agent-hook-endpoint-coordinates'
import { join } from 'node:path'
import { registerRelayPtyOwnershipSourceEndpoint } from './relay-pty-ownership-source-endpoint'

export async function runRelayDaemon(options: RelayLaunchOptions): Promise<void> {
  if (options.detached && options.logFile) {
    installRelayLogRotation(options.logFile)
  }

  const socketOwnership = new RelaySocketOwnership(options.sockPath)
  let fatalPtyHandler: RelayRuntimeServices['ptyHandler'] | null = null
  process.on('uncaughtException', (error) => {
    relayLogLine(`[relay] Uncaught exception: ${error.message}\n${error.stack}`)
    try {
      fatalPtyHandler?.forceKillAllPtyProcesses()
    } catch (reapError) {
      // Why log rather than swallow: exit must still win, but this line is the only
      // forensic trace a crashed remote daemon leaves behind for an orphaned shell.
      relayLogLine(
        `[relay] Fatal PTY reap failed: ${reapError instanceof Error ? reapError.message : String(reapError)}`
      )
    }
    socketOwnership.cleanup()
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    relayLogLine(`[relay] Unhandled rejection: ${String(reason)}`)
  })

  const primaryChannel = new RelayPrimaryChannel()
  const launchVersion = readLaunchVersion()
  const runtime = new RelayRuntimeServices(
    primaryChannel.dispatcher,
    options.graceTimeMs,
    launchVersion,
    {
      // Keep transfer journals beside the relay endpoint so they survive a
      // daemon restart without sharing the hook spool itself.
      ownershipTransferStoreDirectory: join(
        options.endpointDir ?? endpointDirForRelaySocket(options.sockPath),
        'pty-ownership-transfer'
      ),
      enableOwnershipTransferMutation: options.enableOwnershipTransferMutation,
      enableDelegatedOwnershipCapture: options.enableDelegatedOwnershipCapture,
      enableSourceDeliveryRetirement: options.enableSourceDeliveryRetirement
    }
  )
  fatalPtyHandler = runtime.ptyHandler
  let reconnectListener: RelayReconnectListener | null = null
  const agentHooks = new RelayAgentHookRuntime(
    primaryChannel.dispatcher,
    runtime.ptyHandler,
    options.sockPath,
    options.endpointDir
  )
  const runtimeIncarnation = randomUUID()
  const ownsEndpoint = () =>
    socketOwnership.server?.listening === true && socketOwnership.ownsCurrentPath()
  const networkTunnels = new RelayNetworkTunnelRegistry({
    dispatcher: primaryChannel.dispatcher,
    owners: runtime.ptyConsumerSessionAdapter,
    runtimeIncarnation,
    ownsEndpoint
  })
  const readNetworkTunnelStatus = registerRelayNetworkTunnels(
    primaryChannel.dispatcher,
    networkTunnels,
    runtimeIncarnation,
    ownsEndpoint
  )
  const lifecycle = new RelayGraceLifecycle({
    dispatcher: primaryChannel.dispatcher,
    ptyHandler: runtime.ptyHandler,
    detached: options.detached,
    emptyDetachedStartupGraceMs: RELAY_EMPTY_DETACHED_STARTUP_GRACE_MS,
    idleRelayGraceMs: RELAY_IDLE_GRACE_MS,
    readSocketClientCount: () => reconnectListener?.clientCount ?? 0,
    hasAcceptedSocketClient: () => reconnectListener?.hasAcceptedClient ?? false,
    ownsSocketPath: () => socketOwnership.owned,
    fenceNetworkTunnels: () => networkTunnels.fenceForDrain(),
    hasNetworkTunnels: () => networkTunnels.hasTunnels,
    disposeOwnedProcesses: () => runtime.disposeOwnedProcesses(),
    disposeRuntime: () => {
      primaryChannel.dispatcher.dispose()
      runtime.disposeHandlers()
      agentHooks.stop()
      socketOwnership.closeAndCleanup()
    }
  })

  const resetJournal = new RelayOwnerResetPreparationJournal(
    join(
      options.endpointDir ?? endpointDirForRelaySocket(options.sockPath),
      'owner-reset-preparations'
    ),
    options.sockPath,
    launchVersion
  )
  const readOwnerResetStatus = registerRelayOwnerReset(primaryChannel.dispatcher, {
    runtimeIncarnation,
    owners: runtime.ptyConsumerSessionAdapter,
    lifecycle,
    persistPrepared: (request, principal, authenticationKind, assertAuthority) =>
      resetJournal.persist(request, principal, authenticationKind, assertAuthority),
    describePreparation: (principal, authenticationKind) =>
      resetJournal.describe(principal, authenticationKind),
    socket: socketOwnership
  })
  await agentHooks.start()
  reconnectListener = new RelayReconnectListener(
    primaryChannel.dispatcher,
    socketOwnership,
    launchVersion,
    options.credentialFile,
    {
      detachPrimaryInput: () => primaryChannel.detachInput(),
      cancelGrace: (reason) => lifecycle.cancel(reason),
      onLastClientClosed: () => {
        if (!primaryChannel.isAlive) {
          lifecycle.start('socket client closed')
        }
      }
    }
  )
  const startedAt = Date.now()
  registerRelayStatus(
    primaryChannel,
    runtime,
    reconnectListener,
    socketOwnership,
    lifecycle,
    options,
    startedAt,
    readOwnerResetStatus,
    readNetworkTunnelStatus
  )

  try {
    // Why this order: the bind is the only proof of endpoint ownership. A start that loses it
    // exits inside start() and never reaches the credential file, so racing starters cannot
    // rotate the secret a surviving daemon enforces.
    await reconnectListener.start()
    const endpointCredential = publishRelayEndpointCredential(options.credentialFile)
    reconnectListener.setEndpointCredential(endpointCredential)
    registerRelayPtyOwnershipSourceEndpoint({
      enabled: options.enableOwnershipTransferMutation === true,
      dispatcher: primaryChannel.dispatcher,
      source: runtime.ptySourcePublication.ownershipTransfer,
      handler: runtime.ptyHandler,
      readEndpoint: () =>
        endpointCredential && socketOwnership.ownsCurrentPath()
          ? { endpoint: options.sockPath, incumbentVersion: launchVersion, endpointCredential }
          : null
    })
    agentHooks.publishEndpointFile()
  } catch (error) {
    relayLogLine(
      `[relay] Startup failed: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(1)
    return
  }
  if (options.credentialFile) {
    void restrictWindowsRelayEndpointCredential(options.credentialFile)
  }

  primaryChannel.startOutputFailureHandling()
  if (options.detached) {
    lifecycle.start('detached startup')
  } else {
    primaryChannel.startInput({
      onData: () => lifecycle.cancel('stdin data'),
      onDisconnect: (reason) => {
        if ((reconnectListener?.clientCount ?? 0) === 0) {
          lifecycle.start(reason)
        }
      }
    })
  }
  lifecycle.installProcessLifecycle()
  primaryChannel.writeSentinel()
  if (options.detached) {
    primaryChannel.detachPrimaryClient()
  }
}

function registerRelayStatus(
  primaryChannel: RelayPrimaryChannel,
  runtime: RelayRuntimeServices,
  reconnectListener: RelayReconnectListener,
  socketOwnership: RelaySocketOwnership,
  lifecycle: RelayGraceLifecycle,
  options: RelayLaunchOptions,
  startedAt: number,
  readOwnerResetStatus: ReturnType<typeof registerRelayOwnerReset>,
  readNetworkTunnelStatus: ReturnType<typeof registerRelayNetworkTunnels>
): void {
  primaryChannel.dispatcher.onRequest('relay.status', async (_params, context) => {
    const resetStatus = readOwnerResetStatus(context)
    const tunnelStatus = readNetworkTunnelStatus()
    return {
      ...runtime.ptyHandler.getPtyRuntimeIdentity(),
      ...resetStatus,
      ...tunnelStatus,
      capabilities: [
        ...SKILL_RELAY_CAPABILITIES,
        ...resetStatus.capabilities,
        ...tunnelStatus.capabilities
      ],
      pid: process.pid,
      ...(typeof process.versions.bun === 'string' ? { runtimeVersion: process.versions.bun } : {}),
      uptimeMs: Date.now() - startedAt,
      detached: options.detached,
      stdoutAlive: primaryChannel.isAlive,
      memory: process.memoryUsage(),
      ptys: { active: runtime.ptyHandler.activePtyCount },
      ptySourceCredit: {
        enabled: true,
        session: runtime.ptyConsumerSessionAdapter.getDebugSnapshot(),
        publication: runtime.ptySourcePublication.getDebugSnapshot()
      },
      socket: {
        path: options.sockPath,
        owned: socketOwnership.owned,
        listening: socketOwnership.server?.listening ?? false,
        clients: reconnectListener.clientCount,
        acceptedConnections: reconnectListener.acceptedConnections
      },
      grace: {
        active: runtime.ptyHandler.graceTimerActive,
        deadlineAt: lifecycle.deadlineAt,
        reason: lifecycle.reason
      }
    }
  })
}
