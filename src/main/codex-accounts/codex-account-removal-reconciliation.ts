import type { CodexManagedAccountRuntimeSelection } from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import {
  getCodexSelectionLaneKey,
  getWslSelectionKey,
  normalizeCodexRuntimeSelection,
  type CodexAccountSelectionTarget
} from './runtime-selection'

function changedSelectionTargets(
  before: CodexManagedAccountRuntimeSelection,
  after: CodexManagedAccountRuntimeSelection
): CodexAccountSelectionTarget[] {
  const targets: CodexAccountSelectionTarget[] = []
  if (before.host !== after.host) {
    targets.push({ runtime: 'host' })
  }
  for (const key of new Set([...Object.keys(before.wsl), ...Object.keys(after.wsl)])) {
    if ((before.wsl[key] ?? null) !== (after.wsl[key] ?? null)) {
      targets.push({ runtime: 'wsl', wslDistro: key === getWslSelectionKey(null) ? null : key })
    }
  }
  return targets
}

export function reconcileCodexAccountRemoval(
  store: Pick<Store, 'getSettings'>,
  sync: (target: CodexAccountSelectionTarget) => void,
  accountTarget: CodexAccountSelectionTarget,
  previousSelection: CodexManagedAccountRuntimeSelection
): Parameters<Store['updateCodexAccountSettingsAndFlush']>[0] {
  const pending = new Map<string, CodexAccountSelectionTarget>()
  const enqueue = (target: CodexAccountSelectionTarget): void => {
    pending.set(getCodexSelectionLaneKey(target), target)
  }
  // Preserve the host sync removal already performed, including WSL removals.
  enqueue({ runtime: 'host' })
  enqueue(accountTarget)
  for (const target of changedSelectionTargets(
    previousSelection,
    normalizeCodexRuntimeSelection(store.getSettings())
  )) {
    enqueue(target)
  }
  const visited = new Set<string>()
  for (const [key, target] of pending) {
    pending.delete(key)
    const before = normalizeCodexRuntimeSelection(store.getSettings())
    const visit = JSON.stringify([key, before])
    if (visited.has(visit)) {
      throw new Error('Codex account removal reconciliation did not stabilize')
    }
    visited.add(visit)
    sync(target)
    for (const changed of changedSelectionTargets(
      before,
      normalizeCodexRuntimeSelection(store.getSettings())
    )) {
      enqueue(changed)
    }
  }
  const settings = store.getSettings()
  const selection = normalizeCodexRuntimeSelection(settings)
  return {
    codexManagedAccounts: settings.codexManagedAccounts,
    activeCodexManagedAccountId: selection.host,
    activeCodexManagedAccountIdsByRuntime: selection
  }
}
