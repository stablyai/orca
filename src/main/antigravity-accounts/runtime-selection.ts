import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AntigravityManagedAccountRuntimeSelection } from '../../shared/antigravity-managed-account-types'

export type AntigravityAccountSelectionTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export type NormalizedAntigravityAccountSelectionTarget = {
  runtime: 'host' | 'wsl'
  wslDistro: string | null
}

export function normalizeAntigravityAccountSelectionTarget(
  target?: AntigravityAccountSelectionTarget | null
): NormalizedAntigravityAccountSelectionTarget {
  if (target?.runtime === 'wsl') {
    return {
      runtime: 'wsl',
      wslDistro: normalizeWslDistro(target.wslDistro)
    }
  }
  return { runtime: 'host', wslDistro: null }
}

export function normalizeAntigravityRuntimeSelection(
  settings: Pick<
    GlobalSettings,
    'activeAntigravityManagedAccountId' | 'activeAntigravityManagedAccountIdsByRuntime'
  >
): AntigravityManagedAccountRuntimeSelection {
  return {
    host:
      settings.activeAntigravityManagedAccountIdsByRuntime?.host ??
      settings.activeAntigravityManagedAccountId ??
      null,
    wsl: { ...settings.activeAntigravityManagedAccountIdsByRuntime?.wsl }
  }
}

export function getSelectedAntigravityAccountIdForTarget(
  settings: Pick<
    GlobalSettings,
    'activeAntigravityManagedAccountId' | 'activeAntigravityManagedAccountIdsByRuntime'
  >,
  target?: AntigravityAccountSelectionTarget | null
): string | null {
  const selection = normalizeAntigravityRuntimeSelection(settings)
  const normalizedTarget = normalizeAntigravityAccountSelectionTarget(target)
  if (normalizedTarget.runtime === 'host') {
    return selection.host
  }
  if (normalizedTarget.wslDistro) {
    return selection.wsl[getAntigravityWslSelectionKey(normalizedTarget.wslDistro)] ?? null
  }
  const selectedIds = Array.from(new Set(Object.values(selection.wsl).filter(Boolean)))
  return (
    selection.wsl[getAntigravityWslSelectionKey(null)] ??
    (selectedIds.length === 1 ? selectedIds[0] : null)
  )
}

export function setSelectedAntigravityAccountIdForTarget(
  selection: AntigravityManagedAccountRuntimeSelection,
  accountId: string | null,
  target?: AntigravityAccountSelectionTarget | null
): AntigravityManagedAccountRuntimeSelection {
  const normalizedTarget = normalizeAntigravityAccountSelectionTarget(target)
  if (normalizedTarget.runtime === 'host') {
    return { host: accountId, wsl: { ...selection.wsl } }
  }
  if (accountId === null && normalizedTarget.wslDistro === null) {
    return {
      host: selection.host,
      wsl: Object.fromEntries(Object.keys(selection.wsl).map((key) => [key, null]))
    }
  }
  if (normalizedTarget.wslDistro) {
    return {
      host: selection.host,
      wsl: { ...selection.wsl, [getAntigravityWslSelectionKey(normalizedTarget.wslDistro)]: accountId }
    }
  }
  return { ...selection, wsl: { ...selection.wsl, [getAntigravityWslSelectionKey(null)]: accountId } }
}

export function removeAntigravityAccountIdFromSelection(
  selection: AntigravityManagedAccountRuntimeSelection,
  accountId: string
): AntigravityManagedAccountRuntimeSelection {
  const nextWsl: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(selection.wsl)) {
    nextWsl[key] = value === accountId ? null : value
  }
  return {
    host: selection.host === accountId ? null : selection.host,
    wsl: nextWsl
  }
}

export function getAntigravitySelectionTargetForAccount(account: {
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
}): AntigravityAccountSelectionTarget {
  if (account.managedAuthRuntime === 'wsl') {
    return { runtime: 'wsl', wslDistro: account.wslDistro ?? null }
  }
  return { runtime: 'host', wslDistro: null }
}

function getAntigravityWslSelectionKey(wslDistro: string | null): string {
  return wslDistro ?? '__default__'
}

function normalizeWslDistro(wslDistro?: string | null): string | null {
  return wslDistro || null
}
