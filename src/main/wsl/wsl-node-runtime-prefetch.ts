import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { errorMessage } from '../../shared/error-message'
import {
  materializeNodeRuntimeArchive,
  nodeRuntimeArchiveCachePath
} from '../node-runtime/pinned-runtime-materializer'
import { wslHostsGateOpen } from './wsl-host-gate'

/** Off the startup path; the archive is about 55 MB. */
const PREFETCH_DELAY_MS = 60_000

let started: Promise<void> | null = null

export type WslNodeRuntimePrefetchOptions = {
  userDataPath: string
  /** The build's architecture, usually the distros'; an x64 build emulated on Arm fetches the unused x64 archive. */
  arch?: string
  materialize?: typeof materializeNodeRuntimeArchive
}

/** Known without asking a distro, so a prefetch never boots one (E9). */
export function wslNodeRuntimePrefetchTarget(arch: string = process.arch): NodeRuntimeTarget {
  return arch === 'arm64' ? 'linux-arm64-glibc' : 'linux-x64-glibc'
}

/**
 * Once per run, caches the pinned Node archive a first WSL deploy uploads, through the deploy's own
 * materializer (mirror, proxy, hash check). Failures leave the deploy's download path as it was.
 */
export function prefetchWslNodeRuntime(options: WslNodeRuntimePrefetchOptions): Promise<void> {
  started ??= runPrefetch(options)
  return started
}

async function runPrefetch(options: WslNodeRuntimePrefetchOptions): Promise<void> {
  const target = wslNodeRuntimePrefetchTarget(options.arch)
  // Must match deployOrcad's default runtimeCacheRoot.
  const cacheRoot = join(options.userDataPath, 'orcad-artifacts')
  // Present is enough here: the deploy re-hashes on use, so skip a 55 MB hash on every launch.
  if (existsSync(nodeRuntimeArchiveCachePath(target, cacheRoot))) {
    return
  }
  try {
    await (options.materialize ?? materializeNodeRuntimeArchive)(target, cacheRoot, {})
  } catch (error) {
    console.warn(
      `[wsl-hosts] Could not prefetch Node for WSL hosts; a first connect downloads it: ${errorMessage(error)}`
    )
  }
}

export type WslNodeRuntimePrefetchWiring = WslNodeRuntimePrefetchOptions & {
  store: {
    getSettings: () => Pick<GlobalSettings, 'experimentalWslHosts'>
    onSettingsChanged: (
      listener: (
        updates: Partial<GlobalSettings>,
        settings: Pick<GlobalSettings, 'experimentalWslHosts'>
      ) => void
    ) => unknown
  }
  gateOpen?: () => boolean
  schedule?: (run: () => void) => void
}

/** Starts the prefetch once the WSL hosts flag is open and the setting is on, now or when it turns on. */
export function wireWslNodeRuntimePrefetch(wiring: WslNodeRuntimePrefetchWiring): void {
  const gateOpen = wiring.gateOpen ?? wslHostsGateOpen
  const schedule = wiring.schedule ?? scheduleAfterStartup
  let scheduled = false
  const consider = (enabled: boolean): void => {
    if (scheduled || !enabled || !gateOpen()) {
      return
    }
    scheduled = true
    schedule(() => {
      // Turned off during the delay: skip, and let a later turn-on schedule again.
      if (!gateOpen() || wiring.store.getSettings().experimentalWslHosts !== true) {
        scheduled = false
        return
      }
      void prefetchWslNodeRuntime(wiring)
    })
  }
  consider(wiring.store.getSettings().experimentalWslHosts === true)
  wiring.store.onSettingsChanged((updates, settings) => {
    if ('experimentalWslHosts' in updates) {
      consider(settings.experimentalWslHosts === true)
    }
  })
}

function scheduleAfterStartup(run: () => void): void {
  setTimeout(run, PREFETCH_DELAY_MS).unref()
}

export function resetWslNodeRuntimePrefetchForTests(): void {
  started = null
}
