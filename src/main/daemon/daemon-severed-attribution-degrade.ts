import { getInProcessPtyProvider, rebindLocalProviderListeners } from '../ipc/pty'
import { checkDaemonHealth } from './daemon-health'
import { isDaemonRestartInFlight } from './daemon-restart-state'
import { getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { getDaemonRuntimeDir as getRuntimeDir } from './daemon-launch-paths'
import { getLegacyDaemonAdapters } from './daemon-provider-routing'
import { getDaemonProvider, replaceDaemonProvider } from './daemon-provider-state'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { getMacDaemonTccAttributionHealth } from './daemon-tcc-attribution'

/** Protocol health alone cannot clear a measured folder-access denial. */
export function createSeveredDaemonRecoveryProbe(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string
): () => Promise<boolean> {
  return async () => {
    if ((await checkDaemonHealth(socketPath, tokenPath)) !== 'healthy') {
      return false
    }
    const attribution = await getMacDaemonTccAttributionHealth(runtimeDir, socketPath, tokenPath)
    return attribution === 'intact' || (process.platform !== 'darwin' && attribution === 'unknown')
  }
}

/**
 * Swaps the installed provider for a degraded one around the same adapter, keeping every live
 * session routed to the daemon that owns it. Returns false when there is nothing to swap:
 * already degraded, or the adapter is no longer the installed current one.
 */
export async function degradeInstalledProviderForSeveredDaemon(
  current: DaemonPtyAdapter
): Promise<boolean> {
  const installed = getDaemonProvider()
  // Why the restart check: a restart is about to replace this provider graph wholesale; a swap
  // now would race it for the registry and could reinstall the daemon it is retiring.
  if (!installed || isDaemonRestartInFlight()) {
    return false
  }
  if (installed instanceof DegradedDaemonPtyProvider) {
    if (installed.getCurrentAdapter() !== current) {
      return false
    }
    installed.degradeFreshSpawnRouting()
    return true
  }
  const installedCurrent =
    installed instanceof DaemonPtyRouter ? installed.getCurrentAdapter() : installed
  if (installedCurrent !== current) {
    return false
  }
  const runtimeDir = getRuntimeDir()
  const degraded = new DegradedDaemonPtyProvider({
    current,
    legacy: getLegacyDaemonAdapters(installed),
    // Why not getLocalPtyProvider: after install that is the daemon topology itself.
    fallback: getInProcessPtyProvider(),
    probeCurrentDaemonSpawn: createSeveredDaemonRecoveryProbe(
      runtimeDir,
      getDaemonSocketPath(runtimeDir),
      getDaemonTokenPath(runtimeDir)
    )
  })
  // Why before the swap: the daemon's existing sessions must already route to it when the
  // first post-swap attach or write arrives, or they would resolve to the fallback and fail.
  try {
    await degraded.discoverDaemonSessions()
  } catch (error) {
    degraded.disposeProviderOnly()
    throw error
  }
  if (getDaemonProvider() !== installed || isDaemonRestartInFlight()) {
    degraded.disposeProviderOnly()
    return false
  }
  if (installed instanceof DaemonPtyRouter) {
    installed.disposeRouterOnly()
  }
  console.warn(
    '[daemon] DEGRADED MODE: the daemon hosting live terminals lost its macOS TCC attribution. Existing sessions keep working; fresh terminals run on the local provider WITHOUT daemon persistence until you restart the daemon (Manage Sessions → Restart).'
  )
  replaceDaemonProvider(degraded)
  rebindLocalProviderListeners()
  return true
}
