import { collapseHomePath } from '../../shared/skills/bundled/bundled-skill-locations'
import type { OrcaUninstallPath } from '../../shared/uninstall/orca-uninstall-types'

const CODEX_ACCOUNT_HOME = /^codex-accounts[\\/][^\\/]+[\\/]home[\\/](.+)$/u

/** Paths inside Orca's data folder (a managed Codex account home) read as a label, not a long path. */
export function describeOrcaUninstallPath(
  path: string,
  roots: { homeDir: string; userDataPath: string }
): OrcaUninstallPath {
  const display = collapseHomePath(path, roots.homeDir)
  // Collapsing against userData instead of home yields `~/<relative>` only for paths inside it.
  const inData = collapseHomePath(path, roots.userDataPath)
  if (inData === path) {
    return { path: display, orcaData: null }
  }
  const relative = inData.slice(2)
  const codex = CODEX_ACCOUNT_HOME.exec(relative)
  return {
    path: display,
    orcaData: codex ? { kind: 'codex-account', relative: codex[1] } : { kind: 'app-data', relative }
  }
}
