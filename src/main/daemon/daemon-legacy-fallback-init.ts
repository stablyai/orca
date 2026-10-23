import { rebindLocalProviderListeners } from '../ipc/pty/provider/listener-lifecycle'
import { getLocalPtyProvider } from '../ipc/pty/provider/registry'
import { releaseDaemonAdoptionLease } from './daemon-endpoint-adoption'
import { clearSeveredDaemon, installSeveredDaemonController } from './daemon-host-image-state'
import { createLegacyDaemonAdapters } from './daemon-legacy-adapters'
import {
  discoverNewerProtocolHolds,
  isHoldingForNewerProtocolDaemon
} from './daemon-newer-protocol-hold'
import { installDaemonProvider } from './daemon-provider-state'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonSpawner } from './daemon-spawner'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { createSeveredDaemonController } from './daemon-severed-restart'

export type TryInstallLegacyFallbackOnCurrentFailureInput = {
  error: unknown
  signal?: AbortSignal
  runtimeDir: string
  newSpawner: DaemonSpawner
  newAdapter: DaemonPtyAdapter
  probeCurrentDaemonSpawn: () => Promise<boolean>
}

/** Keeps live legacy daemon sessions when the current daemon cannot start or take its lease. */
export async function tryInstallLegacyFallbackOnCurrentFailure(
  input: TryInstallLegacyFallbackOnCurrentFailureInput
): Promise<true> {
  releaseDaemonAdoptionLease(input.newSpawner.getHandle())
  await input.newAdapter.disconnectOnly().catch(() => {
    input.newAdapter.dispose()
  })
  if (input.signal?.aborted) {
    throw input.error
  }
  const [legacyAdapters] = await Promise.all([
    createLegacyDaemonAdapters(input.runtimeDir),
    discoverNewerProtocolHolds(input.runtimeDir)
  ])
  if (legacyAdapters.length === 0 && !isHoldingForNewerProtocolDaemon()) {
    throw input.error
  }
  console.warn(
    '[daemon] Current daemon unavailable; adopting legacy daemon sessions with local fresh spawns',
    input.error
  )
  const degradedProvider = new DegradedDaemonPtyProvider({
    current: input.newAdapter,
    legacy: legacyAdapters,
    fallback: getLocalPtyProvider(),
    currentAvailable: false,
    probeCurrentDaemonSpawn: input.probeCurrentDaemonSpawn
  })
  try {
    await degradedProvider.discoverDaemonSessions()
  } catch (discoveryError) {
    await degradedProvider.disconnectOnly().catch(() => {})
    throw new AggregateError([input.error, discoveryError], 'Legacy daemon fallback failed')
  }
  if (input.signal?.aborted) {
    await degradedProvider.disconnectOnly()
    return true
  }
  installDaemonProvider(input.newSpawner, degradedProvider)
  installSeveredDaemonController(createSeveredDaemonController())
  clearSeveredDaemon()
  rebindLocalProviderListeners()
  return true
}
