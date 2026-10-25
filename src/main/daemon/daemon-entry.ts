import { readFileSync } from 'node:fs'
import { startDaemon, type DaemonHandle } from './daemon-main'
import { createPtySubprocess } from './pty-subprocess'
import { warmWindowsConptyOnce } from './windows-conpty-warmup'
import { warmPwshAvailabilityCache } from '../pwsh'
import { createDaemonFileLog, createNoopDaemonFileLog } from './daemon-file-log'
import { PROTOCOL_VERSION } from './types'
import { detectOwnCgroupScopeUnit, ownFreshDaemonScope } from './daemon-cgroup-scope'
import {
  DAEMON_EXIT_ENDPOINT_OCCUPIED,
  DaemonEndpointUnavailableError
} from './daemon-endpoint-ownership'
import {
  prepareMacosTccLoginShell,
  probeMacosLoginSessionAlive
} from '../providers/macos-tcc-login-shell'
import { MacosLoginSessionDeathWatch } from './macos-login-session-death-watch'
import { readCurrentProcessMacSystemResolverHealth } from '../network/macos-system-resolver-health'
import { readCurrentDaemonReadyIdentity } from './daemon-ready-identity'
import { publishDaemonPidFile } from './daemon-spawner'
import { initializeTerminalScopes } from './terminal-scopes-runtime'
import { isNativePtyException } from './daemon-native-pty-exception'
import { startDaemonScopeDeathWatch } from './daemon-scope-death-watch'
import { isWindowsProcessTableAvailable } from '../windows/windows-process-table'
import { leaseAppImageGenerationForCurrentProcess } from '../cli/appimage-generation-lease'
import { createDaemonShutdownDeadline } from './daemon-shutdown-deadline'

export type ParsedDaemonArgs = {
  socketPath: string
  tokenPath: string
  pidPath?: string
  launchNonce?: string
  entryPath?: string
  appVersion?: string
  spawnerExecPath?: string
  /** GUI-spawned daemons only — headless serve/SSH daemons must survive session loss. */
  loginSessionWatch?: boolean
  freshDaemonScope?: boolean
  logFilePath?: string
}

export function parseArgs(argv: string[]): ParsedDaemonArgs {
  let socketPath = ''
  let tokenPath = ''
  let logFilePath = ''
  let pidPath = ''
  let launchNonce = ''
  let entryPath = ''
  let appVersion = ''
  let spawnerExecPath = ''
  let loginSessionWatch = false
  let freshDaemonScope = false

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--socket' && argv[i + 1]) {
      socketPath = argv[i + 1]
      i++
    } else if (argv[i] === '--token' && argv[i + 1]) {
      tokenPath = argv[i + 1]
      i++
    } else if (argv[i] === '--log-file' && argv[i + 1]) {
      logFilePath = argv[i + 1]
      i++
    } else if (argv[i] === '--pid-record' && argv[i + 1]) {
      pidPath = argv[i + 1]
      i++
    } else if (argv[i] === '--launch-nonce' && argv[i + 1]) {
      launchNonce = argv[i + 1]
      i++
    } else if (argv[i] === '--entry-path' && argv[i + 1]) {
      entryPath = argv[i + 1]
      i++
    } else if (argv[i] === '--app-version' && argv[i + 1]) {
      appVersion = argv[i + 1]
      i++
    } else if (argv[i] === '--spawner-exec-path' && argv[i + 1]) {
      spawnerExecPath = argv[i + 1]
      i++
    } else if (argv[i] === '--login-session-watch') {
      loginSessionWatch = true
    } else if (argv[i] === '--fresh-daemon-scope') {
      freshDaemonScope = true
    }
  }

  if (!socketPath || !tokenPath) {
    throw new Error('Usage: daemon-entry --socket <path> --token <path> [--log-file <path>]')
  }

  if ((pidPath && !launchNonce) || (!pidPath && launchNonce)) {
    throw new Error('Daemon PID record path and launch nonce must be provided together')
  }

  return {
    socketPath,
    tokenPath,
    ...(pidPath ? { pidPath, launchNonce } : {}),
    ...(entryPath ? { entryPath } : {}),
    ...(appVersion ? { appVersion } : {}),
    ...(spawnerExecPath ? { spawnerExecPath } : {}),
    ...(loginSessionWatch ? { loginSessionWatch } : {}),
    ...(freshDaemonScope ? { freshDaemonScope } : {}),
    ...(logFilePath ? { logFilePath } : {})
  }
}

async function main(): Promise<void> {
  // The parent closes startup stderr after readiness; later EPIPE errors must not kill the daemon.
  process.stderr.on('error', () => {})

  const {
    socketPath,
    tokenPath,
    pidPath,
    launchNonce,
    entryPath,
    appVersion,
    spawnerExecPath,
    loginSessionWatch,
    freshDaemonScope,
    logFilePath
  } = parseArgs(process.argv.slice(2))
  const startedAtMs = Date.now() - process.uptime() * 1000
  // Keep the extracted AppImage generation alive after its launcher exits.
  void leaseAppImageGenerationForCurrentProcess()
  const readyIdentity = await readCurrentDaemonReadyIdentity(startedAtMs)
  const daemonLog = logFilePath ? createDaemonFileLog(logFilePath) : createNoopDaemonFileLog()
  daemonLog.log('startup', { protocolVersion: PROTOCOL_VERSION, socketPath })
  const daemonScope = ownFreshDaemonScope(freshDaemonScope === true, launchNonce)
  const log = (event: string, details?: Record<string, unknown>): void =>
    daemonLog.log(event, details)
  const processCeiling = initializeTerminalScopes(daemonScope, log)
  startDaemonScopeDeathWatch({ daemonScope, log })
  void warmPwshAvailabilityCache()

  // Detached stderr is unavailable; retain TCC preflight failures in diagnostic logs.
  const runMacosLoginPreflight = async (): Promise<void> => {
    const outcome = await prepareMacosTccLoginShell()
    if (outcome && !outcome.ok) {
      daemonLog.log('macos-login-preflight', { ok: outcome.ok, reason: outcome.reason })
    }
  }
  // Warm the PAM probe before the first terminal spawn pays its latency.
  void runMacosLoginPreflight()

  // Suppress native PTY callback exceptions to preserve other sessions; rethrow unrelated errors.
  process.on('uncaughtException', (err) => {
    const msg = err?.message ?? ''
    if (isNativePtyException(err)) {
      daemonLog.log('uncaught-exception-suppressed', { name: err?.name, message: msg })
      console.error('[daemon] Native PTY exception (suppressed):', err)
      return
    }
    daemonLog.log('uncaught-exception-fatal', { name: err?.name, message: msg })
    console.error('[daemon] Uncaught exception (fatal):', err)
    throw err
  })

  let daemon: DaemonHandle | null = null
  let deathWatch: MacosLoginSessionDeathWatch | null = null
  let shuttingDown = false
  const shutdownDeadline = createDaemonShutdownDeadline(daemonLog, () => process.exit(0))
  const beginShutdown = (): void => {
    shuttingDown = true
    shutdownDeadline.start()
    // Mark the stop before teardown: losing the AppImage mount to scope shutdown can interrupt it with SIGBUS.
    daemon?.recordStopRequested()
    deathWatch?.stop()
  }

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return
    }
    beginShutdown()
    daemonLog.log('shutdown', { reason })
    try {
      if (daemon) {
        await daemon.shutdown()
        daemon = null
      }
    } catch (err) {
      daemonLog.log('shutdown-error', { message: (err as Error)?.message })
    } finally {
      shutdownDeadline.cancel()
      daemonLog.close()
      process.exit(0)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // Inject verdicts for e2e: fabricating macOS audit-session death requires privileged PAM teardown.
  const e2eProbeFile = process.env.ORCA_E2E_LOGIN_SESSION_PROBE_FILE
  const readE2eVerdict = (): string => {
    try {
      return readFileSync(e2eProbeFile as string, 'utf8').trim()
    } catch {
      return ''
    }
  }
  deathWatch =
    loginSessionWatch && process.platform === 'darwin'
      ? new MacosLoginSessionDeathWatch({
          probeLoginSession: e2eProbeFile
            ? async () => {
                const verdict = readE2eVerdict()
                if (verdict === 'alive') {
                  return { ok: true, conclusive: true, reason: 'accepted' }
                }
                if (verdict === 'dead') {
                  return { ok: false, conclusive: true, reason: 'rejected' }
                }
                return { ok: false, conclusive: false, reason: 'timeout' }
              }
            : probeMacosLoginSessionAlive,
          readResolverHealth: e2eProbeFile
            ? async () => {
                const verdict = readE2eVerdict()
                return verdict === 'dead' || verdict === 'hang' ? 'unhealthy' : 'healthy'
              }
            : readCurrentProcessMacSystemResolverHealth,
          ...(e2eProbeFile
            ? {
                timing: {
                  periodicProbeMs: 2_000,
                  rejectionRecheckMs: 500,
                  minimumRejectionSpanMs: 2_000,
                  ptyExitDebounceMs: 200,
                  clientActivityMinGapMs: 1_000,
                  minProbeGapMs: 100
                }
              }
            : {}),
          log: daemonLog,
          onRetire: (details) => {
            shuttingDown = true
            daemonLog.log('login-session-dead-retire', details)
            daemon?.recordOrderlyExit()
            daemonLog.close()
            // Skip PTY teardown so replacement daemons cold-restore scrollback from unclean session metadata.
            process.exit(1)
          }
        })
      : null

  daemon = await startDaemon({
    socketPath,
    tokenPath,
    ...(pidPath ? { pidPath } : {}),
    ...(launchNonce ? { launchNonce } : {}),
    ...(pidPath ? { startedAtMs } : {}),
    ...(entryPath ? { entryPath } : {}),
    ...(appVersion ? { appVersion } : {}),
    ...(spawnerExecPath ? { spawnerExecPath } : {}),
    ...(pidPath && launchNonce
      ? {
          publishEndpointOwnership: () =>
            publishDaemonPidFile(pidPath, {
              ...readyIdentity,
              ...(entryPath ? { entryPath } : {}),
              ...(appVersion ? { appVersion } : {}),
              ...(spawnerExecPath ? { spawnerExecPath } : {}),
              // Record actual cgroup membership rather than unverified launcher intent.
              cgroupUnit: detectOwnCgroupScopeUnit(),
              processCeiling,
              launchNonce
            })
        }
      : {}),
    log: daemonLog,
    preparePtySpawn: runMacosLoginPreflight,
    ...(deathWatch
      ? {
          onPtySessionExit: () => deathWatch.notifyPtyExit(),
          onAuthenticatedClientPair: () => deathWatch.notifyClientActivity()
        }
      : {}),
    spawnSubprocess: (opts) =>
      createPtySubprocess({
        ...opts,
        ...(process.platform === 'darwin'
          ? {
              onMacosTccSpawnStrategy: (strategy) =>
                daemonLog.log('macos-tcc-pty-spawn', { strategy })
            }
          : {})
      }),
    onIdleShutdown: () => {
      deathWatch?.stop()
      shuttingDown = true
      daemonLog.log('shutdown', { reason: 'idle' })
      daemonLog.close()
      process.exit(0)
    },
    onRpcShutdown: () => {
      shutdownDeadline.cancel()
      daemonLog.close()
      process.exit(0)
    },
    onShutdownRequested: beginShutdown
  })
  deathWatch?.start()

  if (process.send) {
    process.send({ type: 'ready', ...readyIdentity })
  }
  daemonLog.log('ready')

  warmWindowsConptyOnce()
  // Log native-addon availability without stderr and pay dlopen cost before the first teardown.
  if (process.platform === 'win32') {
    daemonLog.log('windows-process-table', { native: isWindowsProcessTableAvailable() })
  }
}

// Tests and build-orcad.mjs load checks import this module without starting a daemon.
const isDirectExecution = !process.env.VITEST && !process.env.ORCA_DAEMON_ENTRY_LOAD_CHECK
if (isDirectExecution) {
  main().catch((err) => {
    console.error('[daemon] Fatal:', err)
    if (err instanceof DaemonEndpointUnavailableError && err.reason === 'occupied') {
      // The launcher settles on exit, which can precede IPC delivery; carry occupied status in the exit code.
      process.send?.({ type: 'endpoint-unavailable', reason: err.reason })
      process.exit(DAEMON_EXIT_ENDPOINT_OCCUPIED)
    }
    process.exit(1)
  })
}
