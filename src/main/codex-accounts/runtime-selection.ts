import type {
  CodexManagedAccount,
  CodexManagedAccountRuntimeSelection,
  GlobalSettings
} from '../../shared/types'

export type CodexAccountSelectionTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export type NormalizedCodexAccountSelectionTarget = {
  runtime: 'host' | 'wsl'
  wslDistro: string | null
}

export function normalizeCodexAccountSelectionTarget(
  target?: CodexAccountSelectionTarget | null
): NormalizedCodexAccountSelectionTarget {
  if (target?.runtime === 'wsl') {
    return {
      runtime: 'wsl',
      wslDistro: normalizeWslDistro(target.wslDistro)
    }
  }
  return { runtime: 'host', wslDistro: null }
}

export function normalizeCodexRuntimeSelection(
  settings: Pick<
    GlobalSettings,
    'activeCodexManagedAccountId' | 'activeCodexManagedAccountIdsByRuntime'
  >
): CodexManagedAccountRuntimeSelection {
  return {
    host:
      settings.activeCodexManagedAccountIdsByRuntime?.host ??
      settings.activeCodexManagedAccountId ??
      null,
    wsl: { ...settings.activeCodexManagedAccountIdsByRuntime?.wsl }
  }
}

export function getSelectedCodexAccountIdForTarget(
  settings: Pick<
    GlobalSettings,
    'activeCodexManagedAccountId' | 'activeCodexManagedAccountIdsByRuntime'
  >,
  target?: CodexAccountSelectionTarget | null
): string | null {
  const selection = normalizeCodexRuntimeSelection(settings)
  const normalizedTarget = normalizeCodexAccountSelectionTarget(target)
  if (normalizedTarget.runtime === 'host') {
    return selection.host
  }
  if (normalizedTarget.wslDistro) {
    return selection.wsl[getWslSelectionKey(normalizedTarget.wslDistro)] ?? null
  }
  const selectedIds = Array.from(new Set(Object.values(selection.wsl).filter(Boolean)))
  return (
    selection.wsl[getWslSelectionKey(null)] ?? (selectedIds.length === 1 ? selectedIds[0] : null)
  )
}

export function setSelectedCodexAccountIdForTarget(
  selection: CodexManagedAccountRuntimeSelection,
  accountId: string | null,
  target?: CodexAccountSelectionTarget | null
): CodexManagedAccountRuntimeSelection {
  const normalizedTarget = normalizeCodexAccountSelectionTarget(target)
  if (normalizedTarget.runtime === 'host') {
    return { host: accountId, wsl: { ...selection.wsl } }
  }
  if (accountId === null && normalizedTarget.wslDistro === null) {
    return {
      host: selection.host,
      wsl: Object.fromEntries(Object.keys(selection.wsl).map((key) => [key, null]))
    }
  }
  return {
    host: selection.host,
    wsl: {
      ...selection.wsl,
      [getWslSelectionKey(normalizedTarget.wslDistro)]: accountId
    }
  }
}

export function removeCodexAccountIdFromSelection(
  selection: CodexManagedAccountRuntimeSelection,
  accountId: string
): CodexManagedAccountRuntimeSelection {
  const nextWsl: Record<string, string | null> = {}
  for (const [distro, selectedId] of Object.entries(selection.wsl)) {
    nextWsl[distro] = selectedId === accountId ? null : selectedId
  }
  return {
    host: selection.host === accountId ? null : selection.host,
    wsl: nextWsl
  }
}

export function pruneInvalidCodexRuntimeSelection(
  selection: CodexManagedAccountRuntimeSelection,
  accounts: CodexManagedAccount[]
): CodexManagedAccountRuntimeSelection {
  const hostAccount = selection.host
    ? accounts.find((account) => account.id === selection.host)
    : null
  const nextWsl: Record<string, string | null> = {}
  for (const [distroKey, accountId] of Object.entries(selection.wsl)) {
    if (!accountId) {
      nextWsl[distroKey] = null
      continue
    }
    const account = accounts.find((entry) => entry.id === accountId)
    nextWsl[distroKey] =
      account &&
      account.managedHomeRuntime === 'wsl' &&
      getWslSelectionKey(account.wslDistro) === distroKey
        ? accountId
        : null
  }
  return {
    host: hostAccount && hostAccount.managedHomeRuntime !== 'wsl' ? selection.host : null,
    wsl: nextWsl
  }
}

export function getCodexSelectionTargetForAccount(
  account: CodexManagedAccount
): CodexAccountSelectionTarget {
  if (account.managedHomeRuntime === 'wsl') {
    return { runtime: 'wsl', wslDistro: account.wslDistro ?? null }
  }
  return { runtime: 'host' }
}

export function getWslSelectionKey(wslDistro: string | null | undefined): string {
  return normalizeWslDistro(wslDistro) ?? '__default__'
}

function normalizeWslDistro(wslDistro: string | null | undefined): string | null {
  const trimmed = wslDistro?.trim()
  return trimmed ? trimmed : null
}
