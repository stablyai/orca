import type {
  ClaudeManagedAccount,
  ClaudeManagedAccountRuntimeSelection,
  GlobalSettings
} from '../../shared/types'

export type ClaudeAccountSelectionTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export type NormalizedClaudeAccountSelectionTarget = {
  runtime: 'host' | 'wsl'
  wslDistro: string | null
}

export function normalizeClaudeAccountSelectionTarget(
  target?: ClaudeAccountSelectionTarget | null
): NormalizedClaudeAccountSelectionTarget {
  if (target?.runtime === 'wsl') {
    return {
      runtime: 'wsl',
      wslDistro: normalizeWslDistro(target.wslDistro)
    }
  }
  return { runtime: 'host', wslDistro: null }
}

export function normalizeClaudeRuntimeSelection(
  settings: Pick<
    GlobalSettings,
    'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'
  >
): ClaudeManagedAccountRuntimeSelection {
  return {
    host:
      settings.activeClaudeManagedAccountIdsByRuntime?.host ??
      settings.activeClaudeManagedAccountId ??
      null,
    wsl: { ...settings.activeClaudeManagedAccountIdsByRuntime?.wsl }
  }
}

export function getSelectedClaudeAccountIdForTarget(
  settings: Pick<
    GlobalSettings,
    'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'
  >,
  target?: ClaudeAccountSelectionTarget | null
): string | null {
  const selection = normalizeClaudeRuntimeSelection(settings)
  const normalizedTarget = normalizeClaudeAccountSelectionTarget(target)
  if (normalizedTarget.runtime === 'host') {
    return selection.host
  }
  if (normalizedTarget.wslDistro) {
    return selection.wsl[getClaudeWslSelectionKey(normalizedTarget.wslDistro)] ?? null
  }
  const selectedIds = Array.from(new Set(Object.values(selection.wsl).filter(Boolean)))
  return (
    selection.wsl[getClaudeWslSelectionKey(null)] ??
    (selectedIds.length === 1 ? selectedIds[0] : null)
  )
}

export function setSelectedClaudeAccountIdForTarget(
  selection: ClaudeManagedAccountRuntimeSelection,
  accountId: string | null,
  target?: ClaudeAccountSelectionTarget | null
): ClaudeManagedAccountRuntimeSelection {
  const normalizedTarget = normalizeClaudeAccountSelectionTarget(target)
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
      [getClaudeWslSelectionKey(normalizedTarget.wslDistro)]: accountId
    }
  }
}

export function removeClaudeAccountIdFromSelection(
  selection: ClaudeManagedAccountRuntimeSelection,
  accountId: string
): ClaudeManagedAccountRuntimeSelection {
  const nextWsl: Record<string, string | null> = {}
  for (const [distro, selectedId] of Object.entries(selection.wsl)) {
    nextWsl[distro] = selectedId === accountId ? null : selectedId
  }
  return {
    host: selection.host === accountId ? null : selection.host,
    wsl: nextWsl
  }
}

export function pruneInvalidClaudeRuntimeSelection(
  selection: ClaudeManagedAccountRuntimeSelection,
  accounts: ClaudeManagedAccount[]
): ClaudeManagedAccountRuntimeSelection {
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
      account.managedAuthRuntime === 'wsl' &&
      getClaudeWslSelectionKey(account.wslDistro) === distroKey
        ? accountId
        : null
  }
  return {
    host: hostAccount && hostAccount.managedAuthRuntime !== 'wsl' ? selection.host : null,
    wsl: nextWsl
  }
}

export function getClaudeSelectionTargetForAccount(
  account: ClaudeManagedAccount
): ClaudeAccountSelectionTarget {
  if (account.managedAuthRuntime === 'wsl') {
    return { runtime: 'wsl', wslDistro: account.wslDistro ?? null }
  }
  return { runtime: 'host' }
}

export function getClaudeWslSelectionKey(wslDistro: string | null | undefined): string {
  return normalizeWslDistro(wslDistro) ?? '__default__'
}

function normalizeWslDistro(wslDistro: string | null | undefined): string | null {
  const trimmed = wslDistro?.trim()
  return trimmed ? trimmed : null
}
