import { resolveLocalAccountRuntimeTarget } from '../../shared/local-account-runtime'
import type { GlobalSettings } from '../../shared/types'

type AccountRuntimeSelection = {
  host: string | null
  wsl: Record<string, string | null>
}

type AccountRuntimeSelectionProvider = {
  getWslSelectionKey: (wslDistro: string | null | undefined) => string
  normalizeRuntimeSelection: (settings: GlobalSettings) => AccountRuntimeSelection
}

type WslRateLimitRuntimeTarget = { runtime: 'wsl'; wslDistro: string | null }

export type AccountRateLimitRuntimeTarget = { runtime: 'host' } | WslRateLimitRuntimeTarget

export function getInitialAccountRateLimitTarget(
  settings: GlobalSettings,
  provider: AccountRuntimeSelectionProvider,
  platform: NodeJS.Platform = process.platform
): AccountRateLimitRuntimeTarget {
  if (settings.localAccountRuntime === 'host') {
    return { runtime: 'host' }
  }

  if (settings.localAccountRuntime === 'wsl') {
    if (platform !== 'win32') {
      return { runtime: 'host' }
    }
    const configuredTarget = resolveLocalAccountRuntimeTarget(settings, platform)
    return {
      runtime: 'wsl',
      wslDistro:
        configuredTarget.wslDistro ??
        getSingleSelectedWslTarget(
          provider.normalizeRuntimeSelection(settings),
          provider.getWslSelectionKey
        )?.wslDistro ??
        null
    }
  }

  // Pre-setting profiles omit the policy and fall back to project/account selection.
  const resolvedTarget = toRateLimitTarget(resolveLocalAccountRuntimeTarget(settings, platform))
  if (settings.localAccountRuntime === 'auto' || resolvedTarget.runtime === 'wsl') {
    return resolvedTarget
  }

  const selection = provider.normalizeRuntimeSelection(settings)
  return selection.host
    ? { runtime: 'host' }
    : (getSingleSelectedWslTarget(selection, provider.getWslSelectionKey) ?? { runtime: 'host' })
}

function getSingleSelectedWslTarget(
  selection: AccountRuntimeSelection,
  getWslSelectionKey: AccountRuntimeSelectionProvider['getWslSelectionKey']
): WslRateLimitRuntimeTarget | null {
  const selectedWslEntries = Object.entries(selection.wsl).filter(([, accountId]) =>
    Boolean(accountId)
  )
  if (selectedWslEntries.length !== 1) {
    return null
  }

  const [distroKey] = selectedWslEntries[0]
  return {
    runtime: 'wsl',
    wslDistro: distroKey === getWslSelectionKey(null) ? null : distroKey
  }
}

function toRateLimitTarget(
  target: ReturnType<typeof resolveLocalAccountRuntimeTarget>
): AccountRateLimitRuntimeTarget {
  return target.runtime === 'wsl'
    ? { runtime: 'wsl', wslDistro: target.wslDistro }
    : { runtime: 'host' }
}
