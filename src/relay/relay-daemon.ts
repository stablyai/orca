import { installRelayLogRotation } from './rotating-log-writer'
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
import { SKILL_RELAY_CAPABILITIES } from './skill-install-handler'

export async function runRelayDaemon(
  options: RelayLaunchOptions,
  endpointCredential: string | undefined
): Promise<void> {
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
    launchVersion
  )
  fatalPtyHandler = runtime.ptyHandler
  let reconnectListener: RelayReconnectListener | null = null
  const agentHooks = new RelayAgentHookRuntime(
    primaryChannel.dispatcher,
    runtime.ptyHandler,
    options.sockPath,
    options.endpointDir
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
    disposeOwnedProcesses: () => runtime.disposeOwnedProcesses(),
    disposeRuntime: () => {
      primaryChannel.dispatcher.dispose()
      runtime.disposeHandlers()
      agentHooks.stop()
      socketOwnership.closeAndCleanup()
    }
  })

  await agentHooks.start()
  reconnectListener = new RelayReconnectListener(
    primaryChannel.dispatcher,
    socketOwnership,
    launchVersion,
    endpointCredential,
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
    startedAt
  )

  try {
    await reconnectListener.start()
    agentHooks.publishEndpointFile()
  } catch {
    process.exit(1)
    return
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
  startedAt: number
): void {
  primaryChannel.dispatcher.onRequest('relay.status', async () => ({
    capabilities: SKILL_RELAY_CAPABILITIES,
    pid: process.pid,
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
  }))
}
