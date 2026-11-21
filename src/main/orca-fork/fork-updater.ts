import { app } from 'electron'
import { FORK_FEATURES } from '../../shared/orca-fork/fork-features'

/** fork: whether the updater may check, download or install; off in the custom build, which updates from the fork's Releases.
 *  Upstream's updater tests still run it, so they keep guarding the code merges bring in. */
export function isUpdaterActive(): boolean {
  return app.isPackaged && (FORK_FEATURES.upstreamUpdater || process.env.VITEST === 'true')
}
