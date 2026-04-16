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
