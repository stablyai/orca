import { HerdrTransport } from './herdr-transport'
import { HerdrDaemon } from './herdr-daemon-class'

// Why: if the spawning app dies without running teardown (crash, force-quit),
// the daemon child is reparented to pid 1 and would otherwise keep serving the
// socket forever with stale code, so every later app run silently talks to it.
function watchForOrphanedParent(): NodeJS.Timeout {
  return setInterval(() => {
    if (process.ppid === 1) {
      console.error('[herdr-daemon] Parent process gone; shutting down')
      process.exit(0)
    }
  }, 5_000)
}

async function main(): Promise<void> {
  const transport = new HerdrTransport()
  const daemon = new HerdrDaemon(transport)
  const orphanWatch = watchForOrphanedParent()

  try {
    await transport.startServer()
    console.error('[herdr-daemon] Daemon started and listening')

    const shutdown = async (): Promise<void> => {
      console.error('[herdr-daemon] Shutting down...')
      clearInterval(orphanWatch)
      await daemon.dispose()
      await transport.close()
      process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } catch (error) {
    console.error('[herdr-daemon] Failed to start:', error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('[herdr-daemon] Fatal error:', error)
  process.exit(1)
})
