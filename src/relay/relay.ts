#!/usr/bin/env node
/* oxlint-disable max-lines -- Why: the entry point keeps process lifecycle and handler registration in one file so the boot sequence stays in topological order. */

/* eslint-disable max-lines -- Why: splitting the entrypoint's startup/reconnect/registration would hide the startup order, the key invariant here. */

// Orca Relay — lightweight daemon deployed to remote hosts over SCP and launched via an SSH exec channel.
// Communicates over stdin/stdout using the framed JSON-RPC protocol.
// On client disconnect it enters a grace period, keeping PTYs alive on a Unix domain socket; a later launch
// reconnects via `relay.js --connect`, bridging the new SSH channel's stdio to the existing relay's socket.

import { createServer, createConnection, type Socket, type Server } from 'node:net'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { unlinkSync, existsSync, statSync } from 'node:fs'
import {
  RELAY_SENTINEL,
  FrameDecoder,
  MessageType,
  encodeJsonRpcFrame,
  parseJsonRpcMessage,
  type DecodedFrame,
  type JsonRpcResponse
} from './protocol'
import { readLaunchVersion, runConnectHandshake, setupDaemonHandshake } from './relay-handshake'
import { RelayDispatcher } from './dispatcher'
import { RelayContext } from './context'
import { PtyHandler } from './pty-handler'
import { FsHandler } from './fs-handler'
import { installRelayLogRotation } from './rotating-log-writer'
import { GitHandler } from './git-handler'
import { PreflightHandler } from './preflight-handler'
import { ExternalAutomationsHandler } from './external-automations-handler'
import { PortScanHandler } from './port-scan-handler'
import { AgentExecHandler } from './agent-exec-handler'
import { WorkspaceSessionHandler } from './workspace-session-handler'
import { endpointDirForRelaySocket, RelayAgentHookServer } from './agent-hook-server'
import { PluginOverlayManager, getRelayPiStatusExtensionPath } from './plugin-overlay'
import {
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD
} from '../shared/agent-hook-relay'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD
} from '../shared/ssh-types'
import { assertPluginSourceUnderByteCap } from './plugin-source-limit'
import { resolveOpenCodeSourceConfigDir, resolvePiSourceAgentDir } from './plugin-overlay-env'
import { detectPiAgentKindFromCommand } from '../shared/pi-agent-kind'
import { resolveSetupAgentSequenceLaunchCommand } from '../shared/setup-agent-sequencing'
import { pickRemoteCliEnv } from './remote-cli-env'
import { relayLogLine } from './relay-diagnostic-log'
import { remoteCliRequestTimeoutMs } from './remote-cli-timeout'
import { shouldReadRemoteCliStdin } from './remote-cli-stdin'
import { registerManagedHookInstaller } from './managed-hook-installer'

const DEFAULT_GRACE_MS = DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
const SOCK_NAME = 'relay.sock'
const CONNECT_TIMEOUT_MS = 5_000
const STALE_SOCKET_PROBE_TIMEOUT_MS = 500
const EMPTY_DETACHED_STARTUP_GRACE_MS = parseNonNegativeIntEnv(
  'ORCA_RELAY_EMPTY_STARTUP_GRACE_MS',
  60_000
)

type SocketIdentity = {
  dev: bigint
  ino: bigint
  ctimeNs: bigint
}

function sameSocketIdentity(a: SocketIdentity, b: SocketIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs
}

function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function readSocketIdentity(sockPath: string): SocketIdentity | null {
  if (isWindowsNamedPipePath(sockPath)) {
    return null
  }
  try {
    const stat = statSync(sockPath, { bigint: true })
    return { dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs }
  } catch {
    return null
  }
}

function isWindowsNamedPipePath(sockPath: string): boolean {
  return process.platform === 'win32' && /^\\\\[.?]\\pipe\\/i.test(sockPath)
}

function parseArgs(argv: string[]): {
  graceTimeMs: number
  connectMode: boolean
  detached: boolean
  cliMode: boolean
  sockPath: string
  endpointDir?: string
  logFile?: string
} {
  let graceTimeMs = DEFAULT_GRACE_MS
  let connectMode = false
  let detached = false
  let cliMode = false
  let sockPath = ''
  let endpointDir: string | undefined
  let logFile: string | undefined
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--grace-time' && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10)
      // Why: flag is seconds (internally ms); 0 keeps the relay alive until explicitly terminated for synced workspaces.
      if (!Number.isNaN(parsed) && parsed >= 0) {
        graceTimeMs = parsed * 1000
      }
      i++
    } else if (argv[i] === '--connect') {
      connectMode = true
    } else if (argv[i] === '--orca-cli') {
      cliMode = true
    } else if (argv[i] === '--detached') {
      detached = true
    } else if (argv[i] === '--sock-path' && argv[i + 1]) {
      sockPath = argv[i + 1]
      i++
    } else if (argv[i] === '--endpoint-dir' && argv[i + 1]) {
      endpointDir = argv[i + 1]
      i++
    } else if (argv[i] === '--log-file' && argv[i + 1]) {
      logFile = argv[i + 1]
      i++
    }
  }
  if (!sockPath) {
    sockPath = join(process.cwd(), SOCK_NAME)
  }
  return { graceTimeMs, connectMode, detached, cliMode, sockPath, endpointDir, logFile }
}

// ── Connect mode ─────────────────────────────────────────────────────
// Why: --connect bridges a new SSH channel's stdin/stdout to the existing relay's socket so the client keeps talking to the process that owns the live PTYs.

function runConnectMode(sockPath: string): void {
  const myVersion = readLaunchVersion()
  const sock = createConnection({ path: sockPath })

  const connectTimeout = setTimeout(() => {
    process.stderr.write(`[relay-connect] Connection timed out after ${CONNECT_TIMEOUT_MS}ms\n`)
    sock.destroy()
    process.exit(1)
  }, CONNECT_TIMEOUT_MS)

  sock.on('connect', () => {
    clearTimeout(connectTimeout)
    runConnectHandshake(sock, myVersion, {
      onAccepted: (leftover: Buffer) => {
        // Why: write RELAY_SENTINEL only after the handshake passes, so a version mismatch is a clean exit-42 instead of a false sentinel + channel drop.
        process.stdout.write(RELAY_SENTINEL)
        // Why: forward handshake-buffered leftover bytes before sock.pipe(process.stdout) so the downstream mux sees them in order.
        if (leftover.length > 0) {
          process.stdout.write(leftover)
        }
        process.stdin.pipe(sock)
        sock.pipe(process.stdout)
      }
    })
  })

  // Why: Node swallows EPIPE on stdout, so the bridge would zombie and drop frames; exit on stdout error so the relay enters grace promptly.
  process.stdout.on('error', () => {
    sock.destroy()
    process.exit(1)
  })

  sock.on('error', (err) => {
    clearTimeout(connectTimeout)
    process.stderr.write(`[relay-connect] Socket error: ${err.message}\n`)
    process.exit(1)
  })

  sock.on('close', () => {
    process.exit(0)
  })
}

async function runOrcaCliMode(sockPath: string, argv: string[]): Promise<void> {
  const myVersion = readLaunchVersion()
  const stdin = shouldReadRemoteCliStdin(argv) ? await readOrcaCliStdin() : undefined
  const sock = createConnection({ path: sockPath })
  let nextSeq = 1
  let highestReceivedSeq = 0
  const requestId = 1

  const sendRequest = (): void => {
    const env = pickRemoteCliEnv(process.env)
    const frame = encodeJsonRpcFrame(
      {
        jsonrpc: '2.0',
        id: requestId,
        method: 'orca.cli',
        params: {
          argv,
          cwd: process.cwd(),
          env,
          ...(stdin !== undefined ? { stdin } : {})
        }
      },
      nextSeq++,
      highestReceivedSeq
    )
    sock.write(frame)
  }

  const decoder = new FrameDecoder((frame: DecodedFrame) => {
    if (frame.id > highestReceivedSeq) {
      highestReceivedSeq = frame.id
    }
    if (frame.type !== MessageType.Regular) {
      return
    }
    const msg = parseJsonRpcMessage(frame.payload)
    if (!('id' in msg) || msg.id !== requestId || !('result' in msg || 'error' in msg)) {
      return
    }
    const response = msg as JsonRpcResponse
    if (response.error) {
      process.stderr.write(`${response.error.message}\n`)
      sock.destroy()
      process.exit(1)
    }
    const result = (response.result ?? {}) as {
      stdout?: unknown
      stderr?: unknown
      exitCode?: unknown
    }
    if (typeof result.stdout === 'string' && result.stdout.length > 0) {
      process.stdout.write(result.stdout)
    }
    if (typeof result.stderr === 'string' && result.stderr.length > 0) {
      process.stderr.write(result.stderr)
    }
    sock.destroy()
    process.exit(typeof result.exitCode === 'number' ? result.exitCode : 0)
  })

  const connectTimeout = setTimeout(() => {
    process.stderr.write(`[orca-cli] Relay connection timed out after ${CONNECT_TIMEOUT_MS}ms\n`)
    sock.destroy()
    process.exit(1)
  }, CONNECT_TIMEOUT_MS)

  sock.on('connect', () => {
    clearTimeout(connectTimeout)
    runConnectHandshake(sock, myVersion, {
      onAccepted: (leftover) => {
        if (leftover.length > 0) {
          decoder.feed(leftover)
        }
        sock.on('data', (chunk) =>
          decoder.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        )
        sendRequest()
      }
    })
  })

  sock.on('error', (err) => {
    clearTimeout(connectTimeout)
    process.stderr.write(`[orca-cli] Relay socket error: ${err.message}\n`)
    process.exit(1)
  })
}

async function readOrcaCliStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

// ── Normal mode ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { graceTimeMs, connectMode, detached, cliMode, sockPath, endpointDir, logFile } = parseArgs(
    process.argv
  )

  if (connectMode) {
    runConnectMode(sockPath)
    return
  }
  if (cliMode) {
    const marker = process.argv.indexOf('--orca-cli')
    await runOrcaCliMode(sockPath, marker >= 0 ? process.argv.slice(marker + 1) : [])
    return
  }

  // Why: only the long-lived detached daemon accumulates relay.log; route it through a size-capped rotator so it can't grow forever.
  if (detached && logFile) {
    installRelayLogRotation(logFile)
  }

  let ownsSocketPath = false
  let ownedSocketIdentity: SocketIdentity | null = null
  const ownsCurrentSocketPath = (): boolean => {
    if (isWindowsNamedPipePath(sockPath)) {
      return ownsSocketPath
    }
    const currentIdentity = readSocketIdentity(sockPath)
    return (
      ownsSocketPath &&
      ownedSocketIdentity !== null &&
      currentIdentity !== null &&
      sameSocketIdentity(currentIdentity, ownedSocketIdentity)
    )
  }
  const cleanupOwnedSocket = (): void => {
    if (ownsCurrentSocketPath()) {
      cleanupSocket(sockPath)
    }
    ownsSocketPath = false
    ownedSocketIdentity = null
  }

  // Why: after an uncaught exception Node's state may be corrupted; log and exit rather than risk data corruption or zombie PTYs.
  process.on('uncaughtException', (err) => {
    relayLogLine(`[relay] Uncaught exception: ${err.message}\n${err.stack}`)
    cleanupOwnedSocket()
    process.exit(1)
  })

  process.on('unhandledRejection', (reason) => {
    relayLogLine(`[relay] Unhandled rejection: ${reason}`)
  })

  // Why: guards writes after the stdin/SSH channel drops so keepalive/pty.data frames don't hit a dead pipe (EPIPE).
  let stdoutAlive = true
  // Why: one-shot waiters parked when stdout saturates (write() === false); flushed on 'drain' and every stdout-death path.
  const stdoutDrainWaiters = new Set<() => void>()
  const flushStdoutDrainWaiters = (): void => {
    for (const cb of Array.from(stdoutDrainWaiters)) {
      stdoutDrainWaiters.delete(cb)
      cb()
    }
  }
  process.stdout.on('drain', flushStdoutDrainWaiters)
  const dispatcher = new RelayDispatcher(
    (data) => {
      if (!stdoutAlive) {
        return
      }
      try {
        // Why: surface Node's backpressure so bulk frames (fs.streamChunk) wait for drain instead of queueing ahead of interactive pty.data.
        return process.stdout.write(data)
      } catch {
        stdoutAlive = false
        flushStdoutDrainWaiters()
        return undefined
      }
    },
    {
      waitWriteDrain: (cb) => {
        if (!stdoutAlive) {
          cb()
          return
        }
        stdoutDrainWaiters.add(cb)
      }
    }
  )

  const context = new RelayContext()

  // Why: registerRoot is a no-op now (allowlist removed, docs/relay-fs-allowlist-removal.md); both handlers kept for version-skew compat until the version floor moves.
  dispatcher.onNotification('session.registerRoot', (params) => {
    const rootPath = params.rootPath as string
    if (rootPath) {
      context.registerRoot(rootPath)
    }
  })

  dispatcher.onRequest('session.registerRoot', async (params) => {
    const rootPath = params.rootPath as string
    if (rootPath) {
      context.registerRoot(rootPath)
    }
    return { ok: true }
  })

  // Why: `~` is a shell expansion Node's fs APIs don't understand; resolve it to an absolute path on the remote host before persisting.
  dispatcher.onRequest('session.resolveHome', async (params) => {
    const inputPath = params.path as string
    if (inputPath === '~' || inputPath === '~/') {
      return { resolvedPath: homedir() }
    }
    if (inputPath.startsWith('~/')) {
      return { resolvedPath: resolve(homedir(), inputPath.slice(2)) }
    }
    return { resolvedPath: inputPath }
  })

  const ptyHandler = new PtyHandler(dispatcher, graceTimeMs)
  const fsHandler = new FsHandler(dispatcher, context)
  const watchRegistry = fsHandler.getWatchRegistry()
  ptyHandler.setWorktreeRemovalCoordinator(watchRegistry)
  watchRegistry.setWorktreePtyTeardown((rootPath) => ptyHandler.shutdownForWorktreePath(rootPath))
  const gitHandler = new GitHandler(dispatcher, context, watchRegistry)

  const _preflightHandler = new PreflightHandler(dispatcher)
  const _externalAutomationsHandler = new ExternalAutomationsHandler(dispatcher)
  void _preflightHandler
  void _externalAutomationsHandler

  const _portScanHandler = new PortScanHandler(dispatcher)
  void _portScanHandler

  const _agentExecHandler = new AgentExecHandler(dispatcher)
  void _agentExecHandler

  const _workspaceSessionHandler = new WorkspaceSessionHandler(dispatcher)
  void _workspaceSessionHandler

  dispatcher.onRequest('orca.cli', async (params, context) => {
    return await dispatcher.requestAnyClient('orca.cli', params, {
      excludeClientId: context.clientId,
      timeoutMs: remoteCliRequestTimeoutMs(params)
    })
  })

  function configureRelayGraceTime(params: Record<string, unknown>): { graceTimeMs: number } {
    const seconds = Number(params.graceTimeSeconds)
    if (Number.isFinite(seconds) && seconds >= 0) {
      // Why: the host sends 0 before system sleep so live remote PTYs survive longer than the ordinary grace window.
      ptyHandler.setGraceTimeMs(Math.floor(seconds) * 1000)
    }
    return { graceTimeMs: ptyHandler.configuredGraceTimeMs }
  }

  dispatcher.onNotification(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, (params) => {
    configureRelayGraceTime(params)
  })
  dispatcher.onRequest(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, async (params) =>
    configureRelayGraceTime(params)
  )

  // ── Agent-hook server ─────────────────────────────────────────────
  // Why: loopback HTTP receiver so remote-PTY agent CLIs post hook events locally, forwarded to Orca as agent.hook notifications. See docs/design/agent-status-over-ssh.md §2-§5.
  const hookServer = new RelayAgentHookServer({
    // Why: scope endpoint.env/cmd by socket path so multiple relay daemons on one account can't overwrite each other's hook tokens.
    endpointDir: endpointDir ?? endpointDirForRelaySocket(sockPath),
    forward: (envelope) => {
      // Why: notify is fire-and-forget and drops during reconnect; the per-paneKey cache lets us replay last status after --connect.
      dispatcher.notify(
        AGENT_HOOK_NOTIFICATION_METHOD,
        envelope as unknown as Record<string, unknown>
      )
    }
  })
  // Why: await the bind before announcing readiness so the first PTY spawn already sees ORCA_AGENT_HOOK_* env; bind failure is soft (log and continue).
  try {
    await hookServer.start({ publishEndpoint: false })
  } catch (err) {
    relayLogLine(
      `[relay] agent-hook server failed to start: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // Why: read the augmenter on every spawn so a late (or restarted) hook-server bind still lands in the next PTY's ORCA_AGENT_HOOK_* env.
  ptyHandler.addEnvAugmenter(() => hookServer.buildPtyEnv())

  // Why: plugin paths resolve on the relay host — OpenCode gets a relay-local overlay; Pi/OMP get extensions in their real remote dirs.
  const pluginOverlay = new PluginOverlayManager()
  ptyHandler.addEnvAugmenter((ctx) => {
    const env: Record<string, string> = {}
    // Why: prefer paneKey for overlay identity so a renderer remount reusing it lands in the same dir; fall back to pty-id when absent.
    const overlayId = ctx.paneKey ?? ctx.id
    if (pluginOverlay.hasOpenCodeSource()) {
      const sourceDir = resolveOpenCodeSourceConfigDir(ctx.env, ctx.shell)
      const dir = pluginOverlay.materializeOpenCode(overlayId, sourceDir)
      if (dir) {
        env.OPENCODE_CONFIG_DIR = dir
        env.ORCA_OPENCODE_CONFIG_DIR = dir
        if (sourceDir) {
          env.ORCA_OPENCODE_SOURCE_CONFIG_DIR = sourceDir
        }
      }
    }
    if (pluginOverlay.hasPiSource()) {
      // Why: install Orca's guarded extension into the launched agent's (Pi vs OMP) real remote dir without redirecting PI_CODING_AGENT_DIR.
      const launchCommandHint = resolveSetupAgentSequenceLaunchCommand(ctx.env, ctx.command)
      const kind = detectPiAgentKindFromCommand(launchCommandHint)
      const hasLaunchCommand =
        typeof launchCommandHint === 'string' && launchCommandHint.trim().length > 0
      const shouldPrepareOmpShadow = kind === 'omp' || !hasLaunchCommand
      if (kind === 'pi') {
        const sourceDir = resolvePiSourceAgentDir(ctx.env, ctx.shell, 'pi')
        const dir = pluginOverlay.materializePi(overlayId, sourceDir, 'pi')
        if (dir) {
          env.ORCA_PI_SOURCE_AGENT_DIR = dir
        }
      }
      if (shouldPrepareOmpShadow) {
        // Why: prepare OMP's status extension for a bare shell so a typed `omp` gets integration, without making OMP the shell's home.
        const sourceDir =
          kind === 'omp'
            ? resolvePiSourceAgentDir(ctx.env, ctx.shell, 'omp')
            : ctx.env.ORCA_OMP_SOURCE_AGENT_DIR
        const dir = pluginOverlay.materializePi(overlayId, sourceDir, 'omp')
        if (dir) {
          env.ORCA_OMP_STATUS_EXTENSION = getRelayPiStatusExtensionPath(dir)
          env.ORCA_OMP_SOURCE_AGENT_DIR = dir
        }
      }
    }
    return env
  })

  // Why: evict pane status cache + overlay dirs on PTY exit so panes don't ghost after reconnect (§5 Path 3) or leak dirs.
  ptyHandler.setExitListener(({ paneKey, id }) => {
    if (paneKey) {
      hookServer.clearPaneState(paneKey)
    }
    pluginOverlay.clearOverlay(paneKey ?? id)
  })

  // Why: forward cached entries as notifications before returning so the response trails all replays, closing a reconnect race. See docs/design/agent-status-over-ssh.md §5 Path 3.
  dispatcher.onRequest(AGENT_HOOK_REQUEST_REPLAY_METHOD, async () => {
    const replayed = hookServer.replayCachedPayloadsForPanes()
    return { replayed }
  })

  // Why: relay-local installers collapse hundreds of SFTP request/response RTTs to one RPC.
  registerManagedHookInstaller(dispatcher)

  // Why: plugin sources ship over the wire so an Orca update doesn't force a relay redeploy; cache them per spawn. See docs/design/agent-status-over-ssh.md §4.
  // Why: bound per-source size so a buggy/hostile Orca can't OOM the relay by pushing a giant string.
  dispatcher.onRequest(AGENT_HOOK_INSTALL_PLUGINS_METHOD, async (params) => {
    const opencode = params.opencodePluginSource
    const pi = params.piExtensionSource
    const omp = params.ompExtensionSource
    assertPluginSourceUnderByteCap('opencodePluginSource', opencode)
    assertPluginSourceUnderByteCap('piExtensionSource', pi)
    assertPluginSourceUnderByteCap('ompExtensionSource', omp)
    pluginOverlay.setSources({
      opencodePluginSource: typeof opencode === 'string' ? opencode : undefined,
      piExtensionSource: typeof pi === 'string' ? pi : undefined,
      ompExtensionSource: typeof omp === 'string' ? omp : undefined
    })
    return {
      installed: {
        opencode: pluginOverlay.hasOpenCodeSource(),
        pi: pluginOverlay.hasPiSource('pi'),
        omp: pluginOverlay.hasPiSource('omp')
      }
    }
  })

  // ── Socket server for reconnection ──────────────────────────────────
  // Why: the SSH channel dies on app restart; a Unix socket lets a new --connect bridge reach the dispatcher that owns live PTYs.

  const socketClients = new Map<Socket, number>()
  let socketServer: Server | null = null
  const launchVersion = readLaunchVersion()
  const startedAt = Date.now()
  let acceptedSocketConnections = 0
  let hasAcceptedSocketClient = false
  let graceDeadlineAt: number | null = null
  let graceReason: string | null = null

  dispatcher.onRequest('relay.status', async () => ({
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    detached,
    stdoutAlive,
    memory: process.memoryUsage(),
    ptys: {
      active: ptyHandler.activePtyCount
    },
    socket: {
      path: sockPath,
      owned: ownsSocketPath,
      listening: socketServer?.listening ?? false,
      clients: socketClients.size,
      acceptedConnections: acceptedSocketConnections
    },
    grace: {
      active: ptyHandler.graceTimerActive,
      deadlineAt: graceDeadlineAt,
      reason: graceReason
    }
  }))

  function cancelGrace(reason: string): void {
    if (ptyHandler.graceTimerActive) {
      relayLogLine(`[relay] Grace canceled: ${reason}`)
    }
    graceDeadlineAt = null
    graceReason = null
    ptyHandler.cancelGraceTimer()
  }

  function attachAcceptedSocket(sock: Socket, leftover: Buffer): void {
    // Why: remove the initial stdin data listener once a socket client is accepted, so stale SSH-channel bytes can't interleave.
    process.stdin.pause()
    process.stdin.removeAllListeners('data')

    hasAcceptedSocketClient = true
    acceptedSocketConnections++
    relayLogLine(
      `[relay] Socket client accepted (clients=${socketClients.size + 1}, accepted=${acceptedSocketConnections})`
    )
    cancelGrace('socket client accepted')

    // Why: same backpressure surface as stdout — bulk frames wait for socket drain so they can't bury interactive PTY frames.
    const sockDrainWaiters = new Set<() => void>()
    const flushSockDrainWaiters = (): void => {
      for (const cb of Array.from(sockDrainWaiters)) {
        sockDrainWaiters.delete(cb)
        cb()
      }
    }
    sock.on('drain', flushSockDrainWaiters)
    sock.on('close', flushSockDrainWaiters)
    sock.on('error', flushSockDrainWaiters)
    const clientId = dispatcher.attachClient(
      (data) => {
        if (!sock.destroyed) {
          return sock.write(data)
        }
        return undefined
      },
      {
        waitWriteDrain: (cb) => {
          if (sock.destroyed) {
            cb()
            return
          }
          sockDrainWaiters.add(cb)
        }
      }
    )
    socketClients.set(sock, clientId)

    // Why: feed handshake-buffered leftover bytes before wiring sock.on('data') so frame ordering is preserved.
    if (leftover.length > 0) {
      dispatcher.feedClient(clientId, leftover)
    }

    sock.on('data', (chunk: Buffer) => {
      cancelGrace('socket client data')
      dispatcher.feedClient(clientId, chunk)
    })
  }

  async function startSocketServer(): Promise<Server> {
    const server = createServer((sock) => {
      // Why: pre-dispatcher version handshake — see relay-handshake.ts.
      setupDaemonHandshake(sock, { launchVersion, onAccepted: attachAcceptedSocket })

      // Why: destroy on 'end' (FIN from --connect's dying channel) so the 'close' handler fires promptly and the daemon enters grace.
      sock.on('end', () => {
        if (!sock.destroyed) {
          sock.destroy()
        }
      })

      sock.on('error', () => {
        // Why: Node emits 'error' then 'close'; the close handler owns cleanup and grace startup.
      })

      sock.on('close', () => {
        const clientId = socketClients.get(sock)
        socketClients.delete(sock)
        if (clientId !== undefined) {
          dispatcher.detachClient(clientId)
        }
        relayLogLine(`[relay] Socket client closed (clients=${socketClients.size})`)
        if (!stdoutAlive && socketClients.size === 0) {
          startGrace('socket client closed')
        }
      })
    })

    // Why: umask 0o177 before listen makes the socket 0o600 atomically, closing the chmod-after-listen TOCTOU window.
    const shouldSetSocketUmask = !isWindowsNamedPipePath(sockPath)
    const prevUmask = shouldSetSocketUmask ? process.umask(0o177) : 0
    let umaskRestored = false
    const restoreUmask = (): void => {
      if (shouldSetSocketUmask && !umaskRestored) {
        process.umask(prevUmask)
        umaskRestored = true
      }
    }

    await new Promise<void>((resolve, reject) => {
      let staleRetryAttempted = false

      function removeStartupListeners(): void {
        server.off('listening', onListening)
        server.off('error', onInitialError)
        server.off('error', failInitial)
      }

      function listenForStartupError(onError: (err: NodeJS.ErrnoException) => void): void {
        server.once('listening', onListening)
        server.once('error', onError)
        server.listen(sockPath)
      }

      function onListening(): void {
        removeStartupListeners()
        restoreUmask()
        ownsSocketPath = true
        ownedSocketIdentity = readSocketIdentity(sockPath)
        server.on('error', (err) => {
          relayLogLine(`[relay] Socket server error: ${err.message}`)
        })
        relayLogLine(`[relay] Socket server listening: ${sockPath}`)
        resolve()
      }

      function failInitial(err: NodeJS.ErrnoException): void {
        removeStartupListeners()
        restoreUmask()
        if (err.code === 'EADDRINUSE') {
          relayLogLine(
            `[relay] Socket path already in use: ${sockPath}; another relay is likely active. Use --connect instead of starting a new daemon.`
          )
        } else {
          relayLogLine(`[relay] Socket server error before listen: ${err.message}`)
        }
        reject(err)
      }

      function unlinkIfStillStale(blockedIdentity: SocketIdentity | null): boolean {
        const currentIdentity = readSocketIdentity(sockPath)
        if (currentIdentity === null) {
          return true
        }
        if (blockedIdentity === null || !sameSocketIdentity(currentIdentity, blockedIdentity)) {
          return false
        }
        try {
          unlinkSync(sockPath)
          return true
        } catch (unlinkErr) {
          const e = unlinkErr as NodeJS.ErrnoException
          return e.code === 'ENOENT'
        }
      }

      // Why: EADDRINUSE may be a stale socket from a crashed relay, not a live one; probe-connect to tell them apart before unlinking.
      function onInitialError(err: NodeJS.ErrnoException): void {
        if (err.code !== 'EADDRINUSE' || staleRetryAttempted) {
          failInitial(err)
          return
        }
        if (isWindowsNamedPipePath(sockPath)) {
          failInitial(err)
          return
        }
        staleRetryAttempted = true
        const blockedIdentity = readSocketIdentity(sockPath)
        const probe = createConnection({ path: sockPath })
        let probeSettled = false
        let probeTimeout: NodeJS.Timeout | null = null
        const finishProbe = (callback: () => void): void => {
          if (probeSettled) {
            return
          }
          probeSettled = true
          if (probeTimeout) {
            clearTimeout(probeTimeout)
          }
          callback()
        }
        probe.once('connect', () => {
          finishProbe(() => {
            probe.destroy()
            failInitial(err)
          })
        })
        probe.once('error', (probeErr: NodeJS.ErrnoException) => {
          finishProbe(() => {
            if (probeErr.code !== 'ECONNREFUSED' && probeErr.code !== 'ENOENT') {
              failInitial(err)
              return
            }
            if (!unlinkIfStillStale(blockedIdentity)) {
              failInitial(err)
              return
            }
            relayLogLine(`[relay] Removed stale socket at ${sockPath} and retrying listen`)
            removeStartupListeners()
            listenForStartupError(failInitial)
          })
        })
        probeTimeout = setTimeout(() => {
          finishProbe(() => {
            probe.destroy()
            failInitial(err)
          })
        }, STALE_SOCKET_PROBE_TIMEOUT_MS)
      }

      listenForStartupError(onInitialError)
    })

    return server
  }

  try {
    socketServer = await startSocketServer()
    // Why: publish endpoint.env only after socket ownership is proven, so a refused duplicate daemon can't poison hook coordinates.
    hookServer.publishEndpointFile()
  } catch {
    process.exit(1)
  }

  // ── stdin/stdout transport (initial connection) ─────────────────────

  // Why: without this handler an EPIPE/ERR_STREAM_DESTROYED on stdout becomes an uncaught exception, exiting before grace starts.
  process.stdout.on('error', () => {
    stdoutAlive = false
    flushStdoutDrainWaiters()
    dispatcher.invalidateClient()
  })

  function startGrace(reason: string): void {
    const startupEmptyDetached =
      detached && !hasAcceptedSocketClient && ptyHandler.activePtyCount === 0
    // Why: a detached relay that never accepted a client has no PTY state and shouldn't linger forever.
    const timeoutMs = startupEmptyDetached
      ? graceTimeMs === 0
        ? EMPTY_DETACHED_STARTUP_GRACE_MS
        : Math.min(graceTimeMs, EMPTY_DETACHED_STARTUP_GRACE_MS)
      : graceTimeMs
    graceDeadlineAt = timeoutMs === 0 ? null : Date.now() + timeoutMs
    graceReason = reason
    relayLogLine(
      `[relay] Grace started (${reason}): timeoutMs=${timeoutMs}, startupEmptyDetached=${startupEmptyDetached}, ptys=${ptyHandler.activePtyCount}, clients=${socketClients.size}`
    )
    ptyHandler.startGraceTimer(() => {
      relayLogLine(`[relay] Grace expired (${reason}); shutting down`)
      shutdown()
    }, timeoutMs)
  }

  if (detached) {
    // Why: detached stdin is /dev/null, so listening would EOF → grace → shutdown before --connect arrives; use the socket instead.
    stdoutAlive = false
    startGrace('detached startup')
  } else {
    process.stdin.on('data', (chunk: Buffer) => {
      cancelGrace('stdin data')
      dispatcher.feed(chunk)
    })

    process.stdin.on('end', () => {
      // Why: stdin close means the SSH channel is gone; mark stdout dead so its write callback no-ops instead of hitting a dead pipe.
      stdoutAlive = false
      flushStdoutDrainWaiters()
      dispatcher.invalidateClient()
      if (socketClients.size === 0) {
        startGrace('stdin ended')
      }
    })

    process.stdin.on('error', () => {
      stdoutAlive = false
      flushStdoutDrainWaiters()
      dispatcher.invalidateClient()
      if (socketClients.size === 0) {
        startGrace('stdin error')
      }
    })
  }

  let shutdownInFlight = false
  function shutdown(): void {
    if (shutdownInFlight) {
      return
    }
    shutdownInFlight = true
    relayLogLine(
      `[relay] Shutdown: ptys=${ptyHandler.activePtyCount}, clients=${socketClients.size}, ownsSocket=${ownsSocketPath}`
    )
    graceDeadlineAt = null
    graceReason = null
    void ptyHandler
      .dispose()
      .then(() => {
        dispatcher.dispose()
        fsHandler.dispose()
        gitHandler.dispose()
        hookServer.stop()
        // Why: server.close() unlinks the listen path; skip if a newer relay rebound it, else we strand that newer daemon.
        if (socketServer && ownsCurrentSocketPath()) {
          socketServer.close()
        }
        cleanupOwnedSocket()
        process.exit(0)
      })
      .catch((error) => {
        // Why: keep owning a PTY whose native kill was rejected so a transient signal failure doesn't orphan a remote shell.
        shutdownInFlight = false
        relayLogLine(
          `[relay] Shutdown deferred: ${error instanceof Error ? error.message : String(error)}`
        )
      })
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  // Why: default SIGHUP exits immediately, killing PTYs before grace; ignore it so the relay survives SSH disconnect.
  process.on('SIGHUP', () => {
    relayLogLine('[relay] Received SIGHUP (SSH session dropped), ignoring')
  })
  process.on('exit', (code) => {
    relayLogLine(`[relay] Process exiting with code ${code}`)
  })

  // Why: the client waits for this exact sentinel string before sending framed data.
  process.stdout.write(RELAY_SENTINEL)
}

function cleanupSocket(sockPath: string): void {
  if (isWindowsNamedPipePath(sockPath)) {
    return
  }
  try {
    if (existsSync(sockPath)) {
      unlinkSync(sockPath)
    }
  } catch {
    /* best-effort */
  }
}

void main().catch((err) => {
  relayLogLine(
    `[relay] Fatal startup error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
  )
  process.exit(1)
})
