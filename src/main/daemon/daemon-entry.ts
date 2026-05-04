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

export function parseArgs(argv: string[]): { socketPath: string; tokenPath: string } {
  let socketPath = ''
  let tokenPath = ''

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--socket' && argv[i + 1]) {
      socketPath = argv[i + 1]
      i++
    } else if (argv[i] === '--token' && argv[i + 1]) {
      tokenPath = argv[i + 1]
      i++
    }
  }

  if (!socketPath || !tokenPath) {
    throw new Error('Usage: daemon-entry --socket <path> --token <path>')
  }

  return { socketPath, tokenPath }
}

async function main(): Promise<void> {
  const { socketPath, tokenPath } = parseArgs(process.argv.slice(2))

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
    spawnSubprocess: (opts) => createPtySubprocess(opts)
  })

  // Signal readiness to parent via IPC (if available)
  if (process.send) {
    process.send({ type: 'ready' })
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
