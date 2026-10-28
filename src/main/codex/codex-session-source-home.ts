import type { GlobalSettings } from '../../shared/global-settings-types'

// Host overrides select the store for new conversations; login and resource homes stay independent.

export function resolveHostCodexSessionSourceHome(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>
): string | undefined {
  return normalizeSourceHome(settings.codexSessionSourceHome?.host)
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
