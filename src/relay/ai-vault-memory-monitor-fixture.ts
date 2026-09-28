import { once } from 'node:events'
import { startBunVaultMemoryMonitor } from '../main/ai-vault/bun-vault-memory-budget'

async function main(): Promise<void> {
  const monitor = startBunVaultMemoryMonitor(128 * 1024 * 1024)
  await once(monitor, 'message')
  monitor.unref()
  if (process.argv[2] === 'idle') {
    console.log('monitor does not retain the service')
    return
  }
  if (process.argv[2] === 'failed-monitor') {
    await monitor.terminate()
    throw new Error('Service survived monitor termination')
  }
  const held: number[][] = []
  for (let i = 0; i < 48; i++) {
    held.push(Array.from({ length: 1_000_000 }, () => i))
    const until = Date.now() + 20
    while (Date.now() < until) {
      // Keep the main thread busy so its timers cannot enforce the budget.
    }
  }
  console.log('allocation survived', held.length)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
