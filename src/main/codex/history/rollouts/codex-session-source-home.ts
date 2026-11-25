import { homedir } from 'node:os'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { expandLeadingHomePath } from '../../../filesystem/home-path-expansion'

// History source overrides do not select auth, config or hook homes.

export function resolveHostCodexSessionSourceHome(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>
): string | undefined {
  const home = normalizeSourceHome(settings.codexSessionSourceHome?.host)
  // People type the folder as `~/...`; every host reader resolves it through here.
  return home && expandLeadingHomePath(home, homedir())
}

export function resolveWslCodexSessionSourceHome(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>,
  distro: string
): string | undefined {
  const perDistro = settings.codexSessionSourceHome?.wsl
  if (!perDistro) {
    return undefined
  }
  // WSL distro names are case-insensitive.
  const normalizedDistro = distro.trim().toLowerCase()
  for (const [key, value] of Object.entries(perDistro)) {
    if (key.trim().toLowerCase() === normalizedDistro) {
      return normalizeSourceHome(value)
    }
  }
  return undefined
}

function normalizeSourceHome(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}
