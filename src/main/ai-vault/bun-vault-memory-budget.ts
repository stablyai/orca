import { Worker } from 'node:worker_threads'

// Bun ignores V8 heap limits; RSS includes native allocations and the monitor itself.
export const BUN_VAULT_MEMORY_BUDGET_BYTES = 768 * 1024 * 1024

const MONITOR_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { writeSync } = require('node:fs')
setInterval(() => {
  const rss = process.memoryUsage.rss()
  if (rss <= workerData.budgetBytes) return
  try {
    writeSync(2, 'Bun AI Vault service exceeded its resident memory budget: ' + rss + '\\n')
  } finally {
    process.kill(process.pid, 'SIGKILL')
  }
}, 250)
parentPort.postMessage('ready')
`

/** Samples RSS independently of transcript parsing; this is not a hard allocation limit. */
export function startBunVaultMemoryMonitor(budgetBytes = BUN_VAULT_MEMORY_BUDGET_BYTES): Worker {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
    throw new Error('Bun AI Vault memory budget must be a positive byte count.')
  }
  const monitor = new Worker(MONITOR_SOURCE, { eval: true, workerData: { budgetBytes } })
  monitor.once('error', (error) => {
    console.error('Bun AI Vault memory monitor failed:', error)
    process.exit(1)
  })
  monitor.once('exit', () => {
    console.error('Bun AI Vault memory monitor stopped unexpectedly.')
    process.exit(1)
  })
  monitor.unref()
  return monitor
}

/** Reclaim the previous scan before allocating another result set. */
export function collectBunVaultScanGarbage(): void {
  if (process.memoryUsage.rss() < 256 * 1024 * 1024) {
    return
  }
  const runtime = 'Bun' in globalThis ? globalThis.Bun : undefined
  if (
    runtime &&
    typeof runtime === 'object' &&
    'gc' in runtime &&
    typeof runtime.gc === 'function'
  ) {
    runtime.gc(true)
  }
}
