#!/usr/bin/env node
/* oxlint-disable max-lines -- Why: the entry point keeps process lifecycle and handler registration in one file so the boot sequence stays in topological order. */

/* eslint-disable max-lines -- Why: splitting the entrypoint's startup/reconnect/registration would hide the startup order, the key invariant here. */

// Orca Relay — lightweight daemon deployed to remote hosts over SCP and launched via an SSH exec channel.
// Communicates over stdin/stdout using the framed JSON-RPC protocol.
// On client disconnect it enters a grace period, keeping PTYs alive on a Unix domain socket; a later launch
// reconnects via `relay.js --connect`, bridging the new SSH channel's stdio to the existing relay's socket.

import { createServer, createConnection, type Socket, type Server } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  unlinkSync,
  existsSync,
  statSync,
  readFileSync,
  chmodSync,
  closeSync,
  openSync
} from 'node:fs'
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
import { RelayContext, expandTilde } from './context'
import { PtyHandler } from './pty-handler'
import { FsHandler } from './fs-handler'
import { installRelayLogRotation } from './rotating-log-writer'
import { GitHandler } from './git-handler'
import { PreflightHandler } from './preflight-handler'
import { ExternalAutomationsHandler } from './external-automations-handler'
import { PortScanHandler } from './port-scan-handler'
import { AgentExecHandler } from './agent-exec-handler'
import { WorkspaceSessionHandler } from './workspace-session-handler'
import { AiVaultHandler } from './ai-vault-handler'
import { createRelayAiVaultService } from './ai-vault-service-factory'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import { parseUnameToRelayPlatform } from '../main/ssh/relay-protocol'
import { RelayAgentHookServer } from './agent-hook-server'
import { endpointDirForRelaySocket } from './agent-hook-endpoint-coordinates'
import { PluginOverlayManager } from './plugin-overlay'
import {
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD
} from '../shared/agent-hook-relay'
import { publishAgentHookEnvelope } from './agent-hook-envelope-publication'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD
} from '../shared/ssh-types'
import { assertPluginSourceUnderByteCap } from './plugin-source-limit'
import { resolveOpenCodeSourceConfigDir, resolvePiSourceAgentDir } from './plugin-overlay-env'
import {
  detectExplicitPiAgentKindFromCommand,
  isPiCompatibleAgentType
} from '../shared/pi-agent-kind'
import { resolveSetupAgentSequenceLaunchCommand } from '../shared/setup-agent-sequencing'
import { pickRemoteCliEnv } from './remote-cli-env'
import {
  applyRelayGraceTimeConfiguration,
  decideRelayGrace,
  type RelayGraceBranch
} from './relay-grace-branch'
import { relayLogLine } from './relay-diagnostic-log'
import { remoteCliRequestTimeoutMs } from './remote-cli-timeout'
import { shouldReadRemoteCliStdin } from './remote-cli-stdin'
import { prepareRemoteArtifactCliInput } from './remote-artifact-cli-input'
import {
  assertRemoteArtifactCliForwardingFits,
  type RemoteArtifactCliForwardingParams
} from './remote-artifact-cli-forwarding'
import { registerManagedHookInstaller } from './managed-hook-installer'
import { registerRelayPluginHostCallHandlers } from './plugin-host-call-handler'
import { DispatcherClientWriter } from './dispatcher-client-writer'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SKILL_RELAY_CAPABILITIES, SkillInstallHandler } from './skill-install-handler'

const DEFAULT_GRACE_MS = DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
const SOCK_NAME = 'relay.sock'
const CONNECT_TIMEOUT_MS = 5_000
const STALE_SOCKET_PROBE_TIMEOUT_MS = 500
const EMPTY_DETACHED_STARTUP_GRACE_MS = parseNonNegativeIntEnv(
  'ORCA_RELAY_EMPTY_STARTUP_GRACE_MS',
  60_000
)
// Why: a relay holding zero PTYs preserves nothing, so an unlimited grace only accumulates idle daemons.
// The env override is test-only — the remote relay is launched over a non-interactive SSH exec channel that carries no client env.
const IDLE_RELAY_GRACE_MS = parseNonNegativeIntEnv('ORCA_RELAY_IDLE_GRACE_MS', 15 * 60_000)

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
  credentialFile?: string
} {
  let graceTimeMs = DEFAULT_GRACE_MS
  let connectMode = false
  let detached = false
  let cliMode = false
  let sockPath = ''
  let endpointDir: string | undefined
  let logFile: string | undefined
  let credentialFile: string | undefined
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
    } else if (argv[i] === '--credential-file' && argv[i + 1]) {
      credentialFile = argv[i + 1]
      i++
    }
  }
  if (!sockPath) {
    sockPath = join(process.cwd(), SOCK_NAME)
  }
  return {
    graceTimeMs,
    connectMode,
    detached,
    cliMode,
    sockPath,
    endpointDir,
    logFile,
    credentialFile
  }
}

function readEndpointCredential(credentialFile: string | undefined): string | undefined {
  if (!credentialFile) {
    return undefined
  }
  const credential = readFileSync(credentialFile, 'utf8').trim()
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(credential)) {
    throw new Error('Relay endpoint credential is missing or invalid')
  }
  if (process.platform !== 'win32') {
    chmodSync(credentialFile, 0o600)
  }
  return credential
}

// ── Connect mode ─────────────────────────────────────────────────────
// Why: --connect bridges a new SSH channel's stdin/stdout to the existing relay's socket so the client keeps talking to the process that owns the live PTYs.

function runConnectMode(sockPath: string, endpointCredential?: string): void {
  const myVersion = readLaunchVersion()
  const sock = createConnection({ path: sockPath })
  const stdoutWriter = new DispatcherClientWriter(
    (data, onSettled) =>
      process.stdout.write(data, (error) => {
        onSettled(error ? { ok: false, error } : { ok: true })
      }),
    {
      supportsWriteCallback: true,
      writableLength: () => process.stdout.writableLength,
      writableHighWaterMark: () => process.stdout.writableHighWaterMark,
      waitWriteDrain: (callback) => {
        process.stdout.once('drain', callback)
        return () => process.stdout.off('drain', callback)
      }
    },
    () => {
      sock.destroy()
      process.exit(1)
    }
  )

  const connectTimeout = setTimeout(() => {
    process.stderr.write(`[relay-connect] Connection timed out after ${CONNECT_TIMEOUT_MS}ms\n`)
    sock.destroy()
    process.exit(1)
  }, CONNECT_TIMEOUT_MS)

  sock.on('connect', () => {
    clearTimeout(connectTimeout)
    runConnectHandshake(
      sock,
      myVersion,
      {
        onAccepted: (leftover: Buffer) => {
          stdoutWriter.enqueue('control', () => Buffer.from(RELAY_SENTINEL), RELAY_SENTINEL.length)
          if (leftover.length > 0) {
            stdoutWriter.enqueue('control', () => leftover, leftover.length)
          }
          process.stdin.pipe(sock)
          sock.on('data', (data: Buffer) => {
            sock.pause()
            let offset = 0
            const writeNext = (): void => {
              if (offset >= data.length) {
                sock.resume()
                return
              }
              const bytes = Math.min(stdoutWriter.producerFrameCapacity, data.length - offset)
              if (bytes <= 0) {
                stdoutWriter.close(new Error('Relay stdout has no producer capacity'))
                return
              }
              const chunk = data.subarray(offset, offset + bytes)
              if (
                !stdoutWriter.enqueue(
                  'ordinary',
                  () => chunk,
                  chunk.length,
                  (result) => {
                    if (!result.ok) {
                      return
                    }
                    offset += bytes
                    writeNext()
                  }
                )
              ) {
                stdoutWriter.close(new Error('Relay stdout bridge capacity exceeded'))
              }
            }
            writeNext()
          })
        }
      },
      endpointCredential
    )
  })

  // Why: Node swallows EPIPE on stdout, so the bridge would zombie and drop frames; exit on stdout error so the relay enters grace promptly.
  process.stdout.on('error', () => {
    stdoutWriter.close(new Error('Relay stdout closed'))
  })

  sock.on('error', (err) => {
    clearTimeout(connectTimeout)
    process.stderr.write(`[relay-connect] Socket error: ${err.message}\n`)
    process.exit(1)
  })

  sock.on('close', async () => {
    await stdoutWriter.waitForIdle()
    process.exit(0)
  })
}

async function runOrcaCliMode(
  sockPath: string,
  argv: string[],
  endpointCredential?: string
): Promise<void> {
  const myVersion = readLaunchVersion()
  let preparedArtifact: Awaited<ReturnType<typeof prepareRemoteArtifactCliInput>>
  try {
    preparedArtifact = await prepareRemoteArtifactCliInput(argv, process.cwd())
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }
  const stdin =
    preparedArtifact.stdin ??
    (shouldReadRemoteCliStdin(argv) ? await readOrcaCliStdin() : undefined)
  const env = pickRemoteCliEnv(process.env)
  const requestParams: RemoteArtifactCliForwardingParams = {
    argv,
    cwd: process.cwd(),
    env,
    ...(stdin !== undefined ? { stdin } : {}),
    ...(preparedArtifact.artifactInput ? { artifactInput: preparedArtifact.artifactInput } : {})
  }
  if (preparedArtifact.artifactInput) {
    try {
      assertRemoteArtifactCliForwardingFits(requestParams)
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
      return
    }
  }
  const sock = createConnection({ path: sockPath })
  const stdoutWriter = new DispatcherClientWriter(
    (data, onSettled) =>
      process.stdout.write(data, (error) => {
        onSettled(error ? { ok: false, error } : { ok: true })
      }),
    {
      supportsWriteCallback: true,
      writableLength: () => process.stdout.writableLength,
      writableHighWaterMark: () => process.stdout.writableHighWaterMark,
      waitWriteDrain: (callback) => {
        process.stdout.once('drain', callback)
        return () => process.stdout.off('drain', callback)
      }
    },
    () => process.exit(1)
  )
  let nextSeq = 1
  let highestReceivedSeq = 0
  const requestId = 1
  const postOutputRequestId = 2
  let initialExitCode = 0

  const sendRequest = (): void => {
    const frame = encodeJsonRpcFrame(
      {
        jsonrpc: '2.0',
        id: requestId,
        method: 'orca.cli',
        params: requestParams
      },
      nextSeq++,
      highestReceivedSeq
    )
    sock.write(frame)
  }

  const finish = (exitCode: number): void => {
    sock.destroy()
    process.exit(exitCode)
  }

  const sendPostOutput = (postOutput: unknown): void => {
    sock.write(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          id: postOutputRequestId,
          method: 'orca.cli.postOutput',
          params: { postOutput, env: pickRemoteCliEnv(process.env) }
        },
        nextSeq++,
        highestReceivedSeq
      )
    )
  }

  const writeOutput = (
    result: { stdout?: unknown; stderr?: unknown },
    onFlushed: (error?: Error) => void
  ): void => {
    let pending = 0
    let completed = false
    const settle = (error?: Error): void => {
      if (completed) {
        return
      }
      if (error) {
        completed = true
        onFlushed(error)
        return
      }
      pending -= 1
      if (pending === 0) {
        completed = true
        onFlushed()
      }
    }
    if (typeof result.stdout === 'string' && result.stdout.length > 0) {
      pending += 1
      const output = Buffer.from(result.stdout)
      stdoutWriter.enqueue(
        'control',
        () => output,
        output.length,
        (settlement) => settle(settlement.ok ? undefined : settlement.error)
      )
    }
    if (typeof result.stderr === 'string' && result.stderr.length > 0) {
      pending += 1
      process.stderr.write(result.stderr, 'utf8', (error) => settle(error ?? undefined))
    }
    if (pending === 0) {
      completed = true
      onFlushed()
    }
  }

  const decoder = new FrameDecoder((frame: DecodedFrame) => {
    if (frame.id > highestReceivedSeq) {
      highestReceivedSeq = frame.id
    }
    if (frame.type !== MessageType.Regular) {
      return
    }
    const msg = parseJsonRpcMessage(frame.payload)
    if (
      !('id' in msg) ||
      (msg.id !== requestId && msg.id !== postOutputRequestId) ||
      !('result' in msg || 'error' in msg)
    ) {
      return
    }
    const response = msg as JsonRpcResponse
    if (response.error) {
      process.stderr.write(`${response.error.message}\n`)
      finish(1)
      return
    }
    if (response.id === postOutputRequestId) {
      finish(initialExitCode)
      return
    }
    const result = (response.result ?? {}) as {
      stdout?: unknown
      stderr?: unknown
      exitCode?: unknown
      postOutput?: unknown
    }
    initialExitCode = typeof result.exitCode === 'number' ? result.exitCode : 0
    writeOutput(result, (error) => {
      if (error) {
        finish(1)
        return
      }
      if (result.postOutput === undefined) {
        finish(initialExitCode)
        return
      }
      sendPostOutput(result.postOutput)
    })
  })

  const connectTimeout = setTimeout(() => {
    process.stderr.write(`[orca-cli] Relay connection timed out after ${CONNECT_TIMEOUT_MS}ms\n`)
    sock.destroy()
    process.exit(1)
  }, CONNECT_TIMEOUT_MS)

  sock.on('connect', () => {
    clearTimeout(connectTimeout)
    runConnectHandshake(
      sock,
      myVersion,
      {
        onAccepted: (leftover) => {
          if (leftover.length > 0) {
            decoder.feed(leftover)
          }
          sock.on('data', (chunk) =>
            decoder.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          )
          sendRequest()
        }
      },
      endpointCredential
    )
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
  const {
    graceTimeMs,
    connectMode,
    detached,
    cliMode,
    sockPath,
    endpointDir,
    logFile,
    credentialFile
  } = parseArgs(process.argv)
  const endpointCredential = readEndpointCredential(credentialFile)

  if (connectMode) {
    runConnectMode(sockPath, endpointCredential)
    return
  }
  if (cliMode) {
    const marker = process.argv.indexOf('--orca-cli')
    await runOrcaCliMode(
      sockPath,
      marker !== -1 ? process.argv.slice(marker + 1) : [],
      endpointCredential
    )
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
    relayLogLine(`[relay] Unhandled rejection: ${String(reason)}`)
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
    (data, onSettled) => {
      if (!stdoutAlive) {
        onSettled({ ok: false, error: new Error('Relay stdout is closed') })
        return false
      }
      try {
        return process.stdout.write(data, (error) => {
          onSettled(error ? { ok: false, error } : { ok: true })
        })
      } catch (error) {
        stdoutAlive = false
        flushStdoutDrainWaiters()
        onSettled({
          ok: false,
          error: error instanceof Error ? error : new Error(String(error))
        })
        return false
      }
    },
    {
      supportsWriteCallback: true,
      writableLength: () => process.stdout.writableLength,
      writableHighWaterMark: () => process.stdout.writableHighWaterMark,
      waitWriteDrain: (cb) => {
        if (!stdoutAlive) {
          cb()
          return
        }
        stdoutDrainWaiters.add(cb)
        return () => stdoutDrainWaiters.delete(cb)
      },
      close: () => {
        stdoutAlive = false
        flushStdoutDrainWaiters()
        // Why close then re-pin: the SSH peer must see EOF, but a long-lived daemon that
        // frees fds 0/1 lets accept()/open() recycle them while Node still treats
        // process.stdin/stdout as those numbers — corrupting socket clients and shutdown.
        for (const fd of [process.stdin.fd, process.stdout.fd]) {
          try {
            closeSync(fd)
          } catch {
            // Already closed by the peer.
          }
        }
        const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null'
        try {
          openSync(devNull, 'r')
        } catch {
          /* best-effort pin of the lowest free fd (normally 0) */
        }
        try {
          openSync(devNull, 'w')
        } catch {
          /* best-effort pin of the next free fd (normally 1) */
        }
      }
    },
    undefined,
    { pauseReads: () => process.stdin.pause(), resumeReads: () => process.stdin.resume() }
  )
  const launchVersion = readLaunchVersion()

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
    // Use the shared expander so Windows `~\…` paths resolve too — a remote
    // relay host can be Windows, where a literal `~\` would otherwise fall
    // through unexpanded and break every downstream fs op.
    return { resolvedPath: expandTilde(inputPath) }
  })

  const ptyHandler = new PtyHandler(dispatcher, graceTimeMs)
  const ptyConsumerSessionAdapter = new SshPtyConsumerSessionAdapter(
    dispatcher,
    launchVersion,
    (id, paused) => ptyHandler.setConsumerDeliveryPaused(id, paused),
    (id) => ptyHandler.handleSourceCreditAvailable(id)
  )
  const ptySourcePublication = new RelayPtySourcePublication(
    dispatcher,
    ptyConsumerSessionAdapter,
    (id) => ptyHandler.handleSourcePublicationCapacity(id)
  )
  ptyHandler.setSourcePublication(ptySourcePublication)
  const fsHandler = new FsHandler(dispatcher, context)
  const watchRegistry = fsHandler.getWatchRegistry()
  ptyHandler.setWorktreeRemovalCoordinator(watchRegistry)
  watchRegistry.setWorktreePtyTeardown((rootPath) => ptyHandler.shutdownForWorktreePath(rootPath))
  const gitHandler = new GitHandler(dispatcher, context, watchRegistry)

  const _preflightHandler = new PreflightHandler(dispatcher)
  const _skillInstallHandler = new SkillInstallHandler(dispatcher)
  const _externalAutomationsHandler = new ExternalAutomationsHandler(dispatcher)
  void _preflightHandler
  void _skillInstallHandler
  void _externalAutomationsHandler

  const _portScanHandler = new PortScanHandler(dispatcher)
  void _portScanHandler

  const _agentExecHandler = new AgentExecHandler(dispatcher)
  void _agentExecHandler

  const _workspaceSessionHandler = new WorkspaceSessionHandler(dispatcher)
  void _workspaceSessionHandler

  const aiVaultRelayPlatform = parseUnameToRelayPlatform(process.platform, process.arch)
  const aiVaultHostPlatform = aiVaultRelayPlatform
    ? getRemoteHostPlatform(aiVaultRelayPlatform)
    : undefined
  const aiVaultService = aiVaultHostPlatform
    ? createRelayAiVaultService(homedir(), aiVaultHostPlatform)
    : null
  const _aiVaultHandler = new AiVaultHandler(dispatcher, {
    hostPlatform: aiVaultHostPlatform,
    service: aiVaultService ?? undefined
  })
  void _aiVaultHandler

  // Why: relay-hosted plugin provisioning is a later phase. Register the
  // enforcement boundary now with no consented identities or runtime services.
  registerRelayPluginHostCallHandlers(
    dispatcher,
    () => null,
    () => ({ grantedCapabilities: null, services: null })
  )

  dispatcher.onRequest('orca.cli', async (params, context) => {
    return await dispatcher.requestAnyClient('orca.cli', params, {
      excludeClientId: context.clientId,
      timeoutMs: remoteCliRequestTimeoutMs(params)
    })
  })
  dispatcher.onRequest('orca.cli.postOutput', async (params, context) => {
    return await dispatcher.requestAnyClient('orca.cli.postOutput', params, {
      excludeClientId: context.clientId,
      timeoutMs: remoteCliRequestTimeoutMs(params)
    })
  })

  function configureRelayGraceTime(params: Record<string, unknown>): { graceTimeMs: number } {
    return applyRelayGraceTimeConfiguration(params.graceTimeSeconds, {
      readConfiguredGraceMs: () => ptyHandler.configuredGraceTimeMs,
      writeConfiguredGraceMs: (graceMs) => ptyHandler.setGraceTimeMs(graceMs),
      isGraceTimerArmed: () => graceDeadlineAt !== null && graceReason !== null,
      isShutdownInFlight: () => shutdownInFlight,
      readGraceBranch: () => graceBranch,
      startGrace
    })
  }

  dispatcher.onNotification(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, (params) => {
    configureRelayGraceTime(params)
  })
  dispatcher.onRequest(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, async (params) =>
    configureRelayGraceTime(params)
  )

  // ── Agent-hook server ─────────────────────────────────────────────
  // Why: loopback HTTP receiver so remote-PTY agent CLIs post hook events to a local port (they can't reach Orca's host); the relay forwards them as agent.hook notifications.
  const hookServer = new RelayAgentHookServer({
    // Why: scope endpoint.env/cmd by socket path so multiple relay daemons on one account can't overwrite each other's hook tokens.
    endpointDir: endpointDir ?? endpointDirForRelaySocket(sockPath),
    // Why: publication is fire-and-forget and drops during reconnect; the per-paneKey cache lets us replay last status after --connect.
    forward: (envelope) => publishAgentHookEnvelope(dispatcher, envelope)
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
      const explicitKind = isPiCompatibleAgentType(ctx.launchAgent)
        ? ctx.launchAgent
        : ctx.launchAgent === undefined
          ? detectExplicitPiAgentKindFromCommand(launchCommandHint)
          : null
      const kind = explicitKind ?? 'pi'
      const hasLaunchCommand =
        typeof launchCommandHint === 'string' && launchCommandHint.trim().length > 0
      const shouldPrepareOmpShadow = kind === 'omp' || !hasLaunchCommand
      if (kind === 'pi') {
        const sourceDir = resolvePiSourceAgentDir(ctx.env, ctx.shell, 'pi')
        // Why: do not mkdir ~/.<agent> on bare shells when the agent home is
        // missing — unused agents kept recreating deleted homes (#10196).
        const result = pluginOverlay.materializePi(overlayId, sourceDir, 'pi', {
          materializeDefaultHome: explicitKind === 'pi'
        })
        if (result?.sourceAgentDir) {
          env.ORCA_PI_SOURCE_AGENT_DIR = result.sourceAgentDir
        }
      }
      if (shouldPrepareOmpShadow) {
        // Why: prepare OMP's status extension for a bare shell so a typed `omp` gets integration, without making OMP the shell's home.
        const sourceDir =
          kind === 'omp'
            ? resolvePiSourceAgentDir(ctx.env, ctx.shell, 'omp')
            : ctx.env.ORCA_OMP_SOURCE_AGENT_DIR
        const result = pluginOverlay.materializePi(overlayId, sourceDir, 'omp', {
          materializeDefaultHome: explicitKind === 'omp'
        })
        // Why: status-only fallback (no sourceAgentDir) is intentional for bare
        // shells without ~/.omp — still export ORCA_OMP_STATUS_EXTENSION (#10196).
        if (result?.statusExtensionPath) {
          env.ORCA_OMP_STATUS_EXTENSION = result.statusExtensionPath
        }
        if (result?.sourceAgentDir) {
          env.ORCA_OMP_SOURCE_AGENT_DIR = result.sourceAgentDir
        }
      }
      if (kind === 'prime-agent') {
        const sourceDir = resolvePiSourceAgentDir(ctx.env, ctx.shell, 'prime-agent')
        const result = pluginOverlay.materializePi(overlayId, sourceDir, 'prime-agent', {
          materializeDefaultHome: explicitKind === 'prime-agent'
        })
        if (result?.sourceAgentDir) {
          env.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR = result.sourceAgentDir
        }
      }
    }
    return env
  })

  // Why: evict pane status cache + overlay dirs on PTY exit, else the next reconnect replays a dead pane's last status (ghost row) and overlay dirs leak.
  ptyHandler.setExitListener(({ paneKey, id }) => {
    if (paneKey) {
      hookServer.clearPaneState(paneKey)
    }
    pluginOverlay.clearOverlay(paneKey ?? id)
  })

  // Why: forward cached entries as notifications before returning, so the response trails every replay and Orca can't treat replay as done while frames are still in flight.
  dispatcher.onRequest(AGENT_HOOK_REQUEST_REPLAY_METHOD, async () => {
    const replayed = hookServer.replayCachedPayloadsForPanes()
    return { replayed }
  })

  // Why: relay-local installers collapse hundreds of SFTP request/response RTTs to one RPC.
  registerManagedHookInstaller(dispatcher)

  // Why: plugin sources ship over the wire — the relay is versioned independently of Orca, so bundling them would make every agent-event change a relay redeploy.
  // Why: bound per-source size so a buggy/hostile Orca can't OOM the relay by pushing a giant string.
  dispatcher.onRequest(AGENT_HOOK_INSTALL_PLUGINS_METHOD, async (params) => {
    const opencode = params.opencodePluginSource
    const pi = params.piExtensionSource
    const omp = params.ompExtensionSource
    const primeAgent = params.primeAgentExtensionSource
    assertPluginSourceUnderByteCap('opencodePluginSource', opencode)
    assertPluginSourceUnderByteCap('piExtensionSource', pi)
    assertPluginSourceUnderByteCap('ompExtensionSource', omp)
    assertPluginSourceUnderByteCap('primeAgentExtensionSource', primeAgent)
    pluginOverlay.setSources({
      opencodePluginSource: typeof opencode === 'string' ? opencode : undefined,
      piExtensionSource: typeof pi === 'string' ? pi : undefined,
      ompExtensionSource: typeof omp === 'string' ? omp : undefined,
      primeAgentExtensionSource: typeof primeAgent === 'string' ? primeAgent : undefined
    })
    return {
      installed: {
        opencode: pluginOverlay.hasOpenCodeSource(),
        pi: pluginOverlay.hasPiSource('pi'),
        omp: pluginOverlay.hasPiSource('omp'),
        primeAgent: pluginOverlay.hasPiSource('prime-agent')
      }
    }
  })

  // ── Socket server for reconnection ──────────────────────────────────
  // Why: the SSH channel dies on app restart; a Unix socket lets a new --connect bridge reach the dispatcher that owns live PTYs.

  const socketClients = new Map<Socket, number>()
  let socketServer: Server | null = null
  const startedAt = Date.now()
  let acceptedSocketConnections = 0
  let hasAcceptedSocketClient = false
  let graceDeadlineAt: number | null = null
  let graceReason: string | null = null
  // Why: only the idle branch is a "nothing left to preserve" bet, so only it may be revoked when a
  // PTY appears mid-window; the other branches keep their armed deadline.
  let graceBranch: RelayGraceBranch | null = null

  dispatcher.onRequest('relay.status', async () => ({
    capabilities: SKILL_RELAY_CAPABILITIES,
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    detached,
    stdoutAlive,
    memory: process.memoryUsage(),
    ptys: {
      active: ptyHandler.activePtyCount
    },
    ptySourceCredit: {
      enabled: true,
      session: ptyConsumerSessionAdapter.getDebugSnapshot(),
      publication: ptySourcePublication.getDebugSnapshot()
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
    graceBranch = null
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
      (data, onSettled) => {
        if (!sock.destroyed) {
          return sock.write(data, (error) => {
            onSettled(error ? { ok: false, error } : { ok: true })
          })
        }
        onSettled({ ok: false, error: new Error('Relay socket is closed') })
        return false
      },
      {
        supportsWriteCallback: true,
        writableLength: () => sock.writableLength,
        writableHighWaterMark: () => sock.writableHighWaterMark,
        close: () => sock.destroy(),
        waitWriteDrain: (cb) => {
          if (sock.destroyed) {
            cb()
            return
          }
          sockDrainWaiters.add(cb)
          return () => sockDrainWaiters.delete(cb)
        }
      },
      {
        principal: `relay-endpoint:${launchVersion}`,
        authenticated: endpointCredential !== undefined,
        allowSessionOwner: endpointCredential !== undefined,
        authenticationKind: endpointCredential ? 'endpoint-credential' : 'unproved'
      },
      {
        pauseReads: () => sock.pause(),
        resumeReads: () => sock.resume()
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
      setupDaemonHandshake(sock, {
        launchVersion,
        endpointCredential,
        onAccepted: attachAcceptedSocket
      })

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
          // Why 'peer-closed' only here: the socket itself ended, which is the one signal that
          // actually says the client is gone rather than merely slow.
          dispatcher.detachClient(clientId, 'peer-closed')
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
    dispatcher.invalidateClient('peer-closed')
  })

  function startGrace(reason: string, options?: { retryDeferredShutdown?: boolean }): void {
    // Why: the live configured value, not the launch-time argv closure — the host can raise the grace
    // after launch via relay.configureGraceTime, and a zero-only gate reading a stale zero would be
    // zero-at-launch-only, i.e. correct only by coincidence.
    const decision = decideRelayGrace({
      configuredGraceMs: ptyHandler.configuredGraceTimeMs,
      relayIdle: isRelayIdle(),
      detached,
      hasAcceptedSocketClient,
      activePtyCount: ptyHandler.activePtyCount,
      retryDeferredShutdown: options?.retryDeferredShutdown === true,
      emptyDetachedStartupGraceMs: EMPTY_DETACHED_STARTUP_GRACE_MS,
      idleRelayGraceMs: IDLE_RELAY_GRACE_MS
    })
    graceBranch = decision.branch
    const timeoutMs = decision.timeoutMs
    graceDeadlineAt = timeoutMs === 0 ? null : Date.now() + timeoutMs
    graceReason = reason
    relayLogLine(
      `[relay] Grace started (${reason}): timeoutMs=${timeoutMs}, branch=${graceBranch}, ptys=${ptyHandler.activePtyCount}, clients=${socketClients.size}`
    )
    ptyHandler.startGraceTimer(() => {
      // Why: last line of defense for the idle cap — a PTY that appeared without announcing itself
      // must not be killed by a timer armed while the relay was still empty (#6955).
      if (graceBranch === 'idle-no-ptys' && !isRelayIdle()) {
        relayLogLine(`[relay] Grace expired (${reason}) but relay is no longer idle; re-evaluating`)
        startGrace(reason)
        return
      }
      relayLogLine(`[relay] Grace expired (${reason}); shutting down`)
      shutdown()
    }, timeoutMs)
  }

  // Why: a creation admitted but not yet pooled already owns a shell, so it counts as non-idle.
  function isRelayIdle(): boolean {
    return ptyHandler.activePtyCount === 0 && ptyHandler.pendingPtyCreationCount === 0
  }

  if (detached) {
    // Why: detached stdin is /dev/null, so listening would EOF → grace → shutdown before --connect arrives; use the socket instead.
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
      dispatcher.invalidateClient('peer-closed')
      if (socketClients.size === 0) {
        startGrace('stdin ended')
      }
    })

    process.stdin.on('error', () => {
      stdoutAlive = false
      flushStdoutDrainWaiters()
      dispatcher.invalidateClient('peer-closed')
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
    graceBranch = null
    void ptyHandler
      .dispose()
      .then(async () => {
        await _skillInstallHandler.dispose().catch((error) => {
          relayLogLine(
            `[relay] Skill upload cleanup failed: ${error instanceof Error ? error.message : String(error)}`
          )
        })
        await aiVaultService?.dispose().catch((error) => {
          relayLogLine(
            `[relay] AI Vault sidecar shutdown failed: ${error instanceof Error ? error.message : String(error)}`
          )
        })
        stopPoolWatch()
        stopPoolActiveWatch()
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
        // Why: the pool watches stay registered — the socket server is still listening, so a client can
        // reconnect and cancel this grace, and that revived relay still needs both re-evaluations.
        shutdownInFlight = false
        relayLogLine(
          `[relay] Shutdown deferred: ${error instanceof Error ? error.message : String(error)}`
        )
        // Why: shutdown() already cleared graceReason, so without re-arming a client-less relay
        // whose kill was refused would stay resident forever with nothing left to retry it.
        if (socketClients.size === 0) {
          startGrace('shutdown deferred', { retryDeferredShutdown: true })
        }
      })
  }

  // Why: with the shipped unlimited default the grace timer is never armed, so an expiry can't
  // notice the pool emptying; re-evaluate on the last exit instead. graceReason (not
  // graceTimerActive) is the only signal that a grace window is open in that configuration.
  // Why: a null deadline is exactly that unlimited case; re-arming a scheduled one would restart
  // an explicitly configured window and double it.
  const stopPoolWatch = ptyHandler.onPtyPoolEmpty(() => {
    if (graceReason !== null && graceDeadlineAt === null && !shutdownInFlight) {
      startGrace('last pty exited')
    }
  })

  // Why: the idle cap is armed on an empty pool, but creation is asynchronous — a spawn or revive
  // admitted after that decision (the client dropped mid-`pty.revive`, say) makes the relay non-idle
  // again, and re-evaluating disarms the timer instead of letting it kill a live PTY (#6955).
  // The grace window itself stays open, so the PTY's own exit still re-arms the cap.
  const stopPoolActiveWatch = ptyHandler.onPtyPoolActive(() => {
    if (graceBranch === 'idle-no-ptys' && graceReason !== null && !shutdownInFlight) {
      startGrace(graceReason)
    }
  })

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  // Why: default SIGHUP exits immediately, killing PTYs before grace; ignore it so the relay survives SSH disconnect.
  process.on('SIGHUP', () => {
    relayLogLine('[relay] Received SIGHUP (SSH session dropped), ignoring')
  })
  process.on('exit', (code) => {
    relayLogLine(`[relay] Process exiting with code ${code}`)
  })

  dispatcher.writePrimaryBytes(Buffer.from(RELAY_SENTINEL))
  if (detached) {
    stdoutAlive = false
    dispatcher.invalidateClient()
  }
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
