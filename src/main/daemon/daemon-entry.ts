/**
 * Daemon entry point — runs as a standalone Node.js process.
 *
 * Usage: node daemon-entry.js --socket /path/to/sock --token /path/to/token
 *
 * Signals readiness to parent via IPC: { type: 'ready' }
 * Shuts down cleanly on SIGTERM.
 */
import { readFileSync } from 'node:fs'
import { startDaemon, type DaemonHandle } from './daemon-main'
import { createPtySubprocess } from './pty-subprocess'
import { warmWindowsConptyOnce } from './windows-conpty-warmup'
import { warmPwshAvailabilityCache } from '../pwsh'
import { createDaemonFileLog, createNoopDaemonFileLog } from './daemon-file-log'
import { PROTOCOL_VERSION } from './types'
import {
  prepareMacosTccLoginShell,
  probeMacosLoginSessionAlive
} from '../providers/macos-tcc-login-shell'
import { MacosLoginSessionDeathWatch } from './macos-login-session-death-watch'
import { readCurrentProcessMacSystemResolverHealth } from '../network/macos-system-resolver-health'

export type ParsedDaemonArgs = {
  socketPath: string
  tokenPath: string
  pidPath?: string
  launchNonce?: string
  /** GUI-spawned daemons only — headless serve/SSH daemons must survive session loss. */
  loginSessionWatch?: boolean
  /** Optional — absent for adopted old daemons and tests, which log nothing. */
  logFilePath?: string
}

export function parseArgs(argv: string[]): ParsedDaemonArgs {
  let socketPath = ''
  let tokenPath = ''
  let logFilePath = ''
  let pidPath = ''
  let launchNonce = ''
  let loginSessionWatch = false

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
    } else if (argv[i] === '--login-session-watch') {
      loginSessionWatch = true
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
    ...(loginSessionWatch ? { loginSessionWatch } : {}),
    ...(logFilePath ? { logFilePath } : {})
  }
}

async function main(): Promise<void> {
  // Why: the parent captures daemon startup stderr then destroys its end of the
  // pipe once the daemon is ready. A later write here (e.g. the uncaughtException
  // console.error below) would then hit a broken pipe and emit 'error' on
  // process.stderr — with no listener that becomes an unhandled error that kills
  // an otherwise healthy detached daemon. Swallow it: stderr is diagnostic only.
  process.stderr.on('error', () => {})

  const { socketPath, tokenPath, pidPath, launchNonce, loginSessionWatch, logFilePath } = parseArgs(
    process.argv.slice(2)
  )
  const startedAtMs = Date.now() - process.uptime() * 1000
  // Fail-open: a broken log path must never block daemon startup.
  const daemonLog = logFilePath ? createDaemonFileLog(logFilePath) : createNoopDaemonFileLog()
  daemonLog.log('startup', { protocolVersion: PROTOCOL_VERSION, socketPath })
  void warmPwshAvailabilityCache()

  // Why: detached daemons destroy stderr, so the preflight's console.warn is lost;
  // surface a degraded TCC attribution here where it's diagnosable (F2).
  const runMacosLoginPreflight = async (): Promise<void> => {
    const outcome = await prepareMacosTccLoginShell()
    if (outcome && !outcome.ok) {
      daemonLog.log('macos-login-preflight', { ok: outcome.ok, reason: outcome.reason })
    }
  }
  // Why: warm the PAM probe at idle startup so the first terminal spawn doesn't
  // pay it under load — shrinking the window where a slow probe degrades (F1/F7).
  void runMacosLoginPreflight()

  // Why: node-pty can throw a C++ Napi::Error that escapes all JS try/catch
  // blocks (e.g. writing to a PTY whose fd was closed between the native
  // exit signal and the JS onExit callback). Without this handler, Node's
  // default behavior is to print the stack and exit — killing the entire
  // daemon and all terminal sessions. Logging and continuing is safe because
  // the individual PTY is already dead; the daemon itself is still healthy.
  // Non-PTY errors (logic bugs, corrupt state) are re-thrown so they still
  // crash the daemon — masking those would hide real issues.
  process.on('uncaughtException', (err) => {
    const msg = err?.message ?? ''
    const isNativeError =
      err?.name === 'Error' &&
      (msg.includes('pty') ||
        msg.includes('Pty') ||
        msg.includes('EIO') ||
        msg.includes('EPIPE') ||
        msg.includes('EBADF') ||
        msg.includes('ENXIO'))
    if (isNativeError) {
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
  // Bound the wait so a wedged native shutdown can't leave the daemon running
  // forever on SIGTERM/SIGINT (it would then survive a real quit, not just updates).
  const SHUTDOWN_TIMEOUT_MS = 5000

  const shutdown = async (reason: string): Promise<void> => {
    // SIGTERM and SIGINT can both fire; guard against a double daemon.shutdown().
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    deathWatch?.stop()
    daemonLog.log('shutdown', { reason })
    try {
      if (daemon) {
        await Promise.race([
          daemon.shutdown(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('shutdown timeout')), SHUTDOWN_TIMEOUT_MS)
          )
        ])
        daemon = null
      }
    } catch (err) {
      // Never let a rejected shutdown() escape as an unhandled rejection and skip exit.
      daemonLog.log('shutdown-error', { message: (err as Error)?.message })
    } finally {
      daemonLog.close()
      process.exit(0)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // Why: a dead macOS login session cannot be fabricated without root (PAM owns
  // audit-session teardown), so e2e drives the oracles from a verdict file:
  // 'alive' → accepted/healthy, 'dead' → rejected/unhealthy, 'hang' →
  // timeout-inconclusive/unhealthy (the fail-safe path), else inconclusive.
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
            daemonLog.close()
            // Why: crash-style exit (no PTY teardown) keeps session meta unclean so the
            // replacement daemon cold-restores scrollback; stale socket/pid files ride
            // the existing dead-endpoint recovery.
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
    log: daemonLog,
    preparePtySpawn: runMacosLoginPreflight,
    ...(deathWatch
      ? {
          onPtySessionExit: () => deathWatch.notifyPtyExit(),
          onAuthenticatedClientPair: () => deathWatch.notifyClientActivity()
        }
      : {}),
    spawnSubprocess: (opts) => createPtySubprocess(opts),
    onIdleShutdown: () => {
      deathWatch?.stop()
      shuttingDown = true
      daemonLog.log('shutdown', { reason: 'idle' })
      daemonLog.close()
      process.exit(0)
    }
  })
  deathWatch?.start()

  // Signal readiness to parent via IPC (if available)
  if (process.send) {
    // Why: Windows has no cheap OS query for a child's start time, so the
    // daemon self-reports it here for the pid file's pid-recycling guard.
    process.send({ type: 'ready', startedAtMs })
  }
  daemonLog.log('ready')

  warmWindowsConptyOnce()
}

// Only auto-run when executed directly (not imported for testing)
const isDirectExecution = !process.env.VITEST
if (isDirectExecution) {
  main().catch((err) => {
    console.error('[daemon] Fatal:', err)
    process.exit(1)
  })
}
