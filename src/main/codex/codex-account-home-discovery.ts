import { lstatSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { discoverCodexStoreHomes } from './codex-launch-home'

/** Includes retired accounts and stores selected before a source-home change. */
export function getCodexAccountHomeSessionDirectories(): string[] {
  return discoverCodexStoreHomes().flatMap((home) => {
    const sessions = join(home, 'sessions')
    try {
      // Only overlays deliberately redirect sessions; legacy homes cannot scan unrelated trees.
      return basename(dirname(home)) === 'overlays' || lstatSync(sessions).isDirectory()
        ? [sessions]
        : []
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
      return []
    }
  })
}
