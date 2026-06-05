/**
 * Daemon entry point — runs as a standalone Node.js process.
 *
 * Usage: node daemon-entry.js --socket /path/to/sock --token /path/to/token
 *
 * Signals readiness to parent via IPC: { type: 'ready' }
 * Shuts down cleanly on SIGTERM.
 */
import { startDaemon, type DaemonHandle } from './daemon-main'
import { createPtySubprocess } from './pty-subprocess'

export function parseArgs(argv: string[]): { socketPath: string; tokenPath: string; parentPid: number | null } {
  let socketPath = ''
  let tokenPath = ''
  let parentPid: number | null = null

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--socket' && argv[i + 1]) {
      socketPath = argv[i + 1]
      i++
    } else if (argv[i] === '--token' && argv[i + 1]) {
      tokenPath = argv[i + 1]
      i++
    } else if (argv[i] === '--parent-pid' && argv[i + 1]) {
      const parsed = Number(argv[i + 1])
      if (Number.isFinite(parsed) && parsed > 0) {
        parentPid = parsed
      }
      i++
    }
  }

  if (!socketPath || !tokenPath) {
    throw new Error('Usage: daemon-entry --socket <path> --token <path>')
  }

  return { socketPath, tokenPath, parentPid }
}

// Why: poll rather than relying on SIGHUP — detached daemons don't receive
// SIGHUP when the parent exits on Linux (SIGHUP only goes to the process
// group leader on terminal close). Polling is reliable across all platforms.
const PARENT_WATCHDOG_INTERVAL_MS = 5_000
// Why: grace period lets Orca reopen (auto-update, manual restart) before
// orphaned PTY sessions are reaped. Short enough to bound zombie accumulation,
// long enough for an AppImage self-update to restart within the window.
const ORPHAN_KILL_GRACE_MS = 30_000

function startParentWatchdog(
  parentPid: number,
  shutdown: () => Promise<void>,
  onClientConnected: (cancel: () => void) => void
): void {
  let orphanKillTimer: ReturnType<typeof setTimeout> | null = null

  const cancelOrphanKill = (): void => {
    if (orphanKillTimer) {
      clearTimeout(orphanKillTimer)
      orphanKillTimer = null
    }
  }

  // Why: expose cancel so a reconnecting Orca client can abort an in-flight kill.
  onClientConnected(cancelOrphanKill)

  const watchdog = setInterval(() => {
    let parentAlive: boolean
    try {
      process.kill(parentPid, 0)
      parentAlive = true
    } catch {
      parentAlive = false
    }

    if (parentAlive) {
      // Parent still running — cancel any pending orphan kill from a transient blip.
      cancelOrphanKill()
      return
    }

    // Parent is dead. Start grace period if not already counting down.
    if (!orphanKillTimer) {
      orphanKillTimer = setTimeout(() => {
        clearInterval(watchdog)
        void shutdown()
      }, ORPHAN_KILL_GRACE_MS)
    }
  }, PARENT_WATCHDOG_INTERVAL_MS)
}

async function main(): Promise<void> {
  const { socketPath, tokenPath, parentPid } = parseArgs(process.argv.slice(2))

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
      console.error('[daemon] Native PTY exception (suppressed):', err)
      return
    }
    console.error('[daemon] Uncaught exception (fatal):', err)
    throw err
  })

  let daemon: DaemonHandle | null = null
  let pendingCancelOrphanKill: (() => void) | null = null

  const shutdown = async (): Promise<void> => {
    if (daemon) {
      await daemon.shutdown()
      daemon = null
    }
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())

  daemon = await startDaemon({
    socketPath,
    tokenPath,
    spawnSubprocess: (opts) => createPtySubprocess(opts),
    // Why: a reconnecting Orca client resets the orphan-kill grace period so
    // warm-reattach relaunches (auto-update, manual restart within 30s) don't
    // lose running terminal sessions unnecessarily.
    onClientConnected: () => pendingCancelOrphanKill?.()
  })

  // Signal readiness to parent via IPC (if available)
  if (process.send) {
    process.send({ type: 'ready' })
  }

  // Why: start watchdog only after the daemon is ready and readiness has been
  // signalled. If --parent-pid was omitted (tests, manual invocation) skip the
  // watchdog entirely — orphan cleanup is the caller's responsibility.
  if (parentPid !== null) {
    startParentWatchdog(parentPid, shutdown, (cancelFn) => {
      pendingCancelOrphanKill = cancelFn
    })
  }
}

// Only auto-run when executed directly (not imported for testing)
const isDirectExecution = !process.env.VITEST
if (isDirectExecution) {
  main().catch((err) => {
    console.error('[daemon] Fatal:', err)
    process.exit(1)
  })
}
