import { stopLocalTerminalDaemons } from '../../launch/local-terminal-daemon-stop'
import { getAllDaemonAdapters } from './daemon-provider-routing'
import { getDaemonProvider, shutdownDaemon } from './daemon-provider-state'
import { DegradedDaemonPtyProvider } from '../routing/degraded-daemon-pty-provider'

/**
 * Uninstall from the running app. Disposing the provider first closes every adapter's respawn, so
 * losing the daemon cannot start a new one; the disposed provider stays registered until quit and
 * refuses new terminals instead of launching a daemon.
 */
export async function stopTerminalDaemonsForUninstall(userDataPath: string): Promise<void> {
  const provider = getDaemonProvider()
  if (provider) {
    // Daemon shutdown suppresses exit fanout; end panes first so none keeps writing to a dead terminal.
    for (const adapter of getAllDaemonAdapters(provider)) {
      adapter.fanoutSyntheticExits(-1)
    }
    if (provider instanceof DegradedDaemonPtyProvider) {
      provider.fanoutCurrentDaemonSyntheticExits(-1)
    }
  }
  await shutdownDaemon().catch((error: unknown) => {
    // The sweep below retries through the daemon's own endpoint and reports what is left.
    console.warn('[uninstall] Terminal daemon shutdown failed:', error)
  })
  await stopLocalTerminalDaemons(userDataPath)
}
