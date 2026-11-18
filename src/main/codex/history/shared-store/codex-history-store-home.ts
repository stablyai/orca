import { isAbsolute } from 'node:path'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { getSystemCodexHomePath } from '../../configuration/homes/codex-home-paths'
import {
  resolveHostCodexSessionSourceHome,
  resolveWslCodexSessionSourceHome
} from '../rollouts/codex-session-source-home'

type HistoryFolderSettings = Pick<GlobalSettings, 'codexSessionSourceHome'>

const reportedFolders = new Set<string>()

function reportUnusable(folder: string, reason: string): void {
  if (!reportedFolders.has(folder)) {
    reportedFolders.add(folder)
    console.warn(
      `[codex-account-history] Codex history folder ${folder} ${reason}; using the default`
    )
  }
}

/**
 * Where every host Codex account keeps and resumes its conversations: the configured Codex
 * history folder, else ~/.codex. A folder inside a WSL distro is that distro's, not the host's.
 */
export function hostCodexHistoryStoreHome(settings: HistoryFolderSettings): string {
  const folder = resolveHostCodexSessionSourceHome(settings)
  if (!folder) {
    return getSystemCodexHomePath()
  }
  if (parseWslUncPath(folder)) {
    return getSystemCodexHomePath()
  }
  if (!isAbsolute(folder)) {
    reportUnusable(folder, 'is not an absolute path')
    return getSystemCodexHomePath()
  }
  return folder
}

/** A distro's configured Codex history folder as its Linux path; null keeps the distro's ~/.codex. */
export function wslCodexHistoryStoreHome(
  settings: HistoryFolderSettings,
  distro: string
): string | null {
  const folder = resolveWslCodexSessionSourceHome(settings, distro)
  if (!folder) {
    return null
  }
  const unc = parseWslUncPath(folder)
  if (unc) {
    return unc.distro.toLowerCase() === distro.toLowerCase() ? unc.linuxPath : null
  }
  if (!folder.startsWith('/')) {
    reportUnusable(folder, `is not a Linux path in ${distro}`)
    return null
  }
  return folder
}
