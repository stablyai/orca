import type {
  LegacyTerminalIdentityClaims,
  LegacyTerminalCatalogEpoch
} from '../persistence/loading-store/legacy-terminal-identity-claims'
import type { WorktreePtyHostFence } from '../runtime/workspaces/removal/worktree-pty-host-fence'
import type { TerminalSurfaceCloseTarget } from '../../shared/workspace-layout/terminal-surface-close-target'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../shared/workspace-scope'

export type LegacyTerminalRestoreAttempt = {
  catalog: LegacyTerminalCatalogEpoch
  readinessDeadline: number
  catalogDeclined?: true
  workspace: string
  tabId?: string
  leafId?: string
  revision: number
  originalId?: string
  originalIncarnation?: string
  closed: boolean
  selectedId?: string
  close: AbortController
}
const failedStopByAuthority = new WeakMap<object, (id: string, reason: string) => void>()
const attemptsByAuthority = new WeakMap<
  object,
  Map<string, Map<string, Set<LegacyTerminalRestoreAttempt>>>
>()

export function admitLegacyTerminalRestore(
  authority: LegacyTerminalIdentityClaims,
  workspace: string,
  tabId?: string,
  leafId?: string,
  markUnverifiable?: (id: string, reason: string) => void
): { attempt: LegacyTerminalRestoreAttempt; release: () => void } {
  if (markUnverifiable) {
    failedStopByAuthority.set(authority, markUnverifiable)
  }
  workspace = normalizeWorkspaceSessionKeyToWorkspaceId(workspace)
  const workspaces = attemptsByAuthority.get(authority) ?? new Map()
  attemptsByAuthority.set(authority, workspaces)
  const tabs = workspaces.get(workspace) ?? new Map()
  workspaces.set(workspace, tabs)
  const attempts = tabs.get(tabId ?? '') ?? new Set<LegacyTerminalRestoreAttempt>()
  tabs.set(tabId ?? '', attempts)
  const attempt: LegacyTerminalRestoreAttempt = {
    catalog: authority.captureExternalCatalog(),
    readinessDeadline: Date.now() + LEGACY_TERMINAL_CATALOG_WAIT_MS,
    workspace,
    tabId,
    leafId,
    revision: 0,
    closed: false,
    close: new AbortController()
  }
  attempts.add(attempt)
  return {
    attempt,
    release: () => {
      const current = tabs.get(attempt.tabId ?? '')
      current?.delete(attempt)
      if (!current?.size) {
        tabs?.delete(attempt.tabId ?? '')
      }
      if (!tabs.size) {
        workspaces.delete(workspace)
      }
    }
  }
}

const LEGACY_TERMINAL_CATALOG_WAIT_MS = 1_000

export function closeLegacyTerminalRestores(
  authority: LegacyTerminalIdentityClaims,
  workspace: string,
  target?: TerminalSurfaceCloseTarget
): void {
  const tabs = attemptsByAuthority
    .get(authority)
    ?.get(normalizeWorkspaceSessionKeyToWorkspaceId(workspace))
  if (!tabs) {
    return
  }
  const groups = target ? [tabs.get(target.tabId), tabs.get('')] : [...tabs.values()]
  for (const group of groups) {
    for (const attempt of group ?? []) {
      if (target?.kind === 'pane' && attempt.leafId && attempt.leafId !== target.leafId) {
        continue
      }
      attempt.closed = true
      attempt.close.abort(new Error('terminal_pane_owner_changed'))
    }
  }
}

export function locateLegacyTerminalRestore(
  authority: LegacyTerminalIdentityClaims,
  attempt: LegacyTerminalRestoreAttempt,
  tabId: string,
  leafId: string
): void {
  const tabs = attemptsByAuthority.get(authority)?.get(attempt.workspace)
  if (attempt.closed) {
    return
  }
  const previous = tabs?.get(attempt.tabId ?? '')
  previous?.delete(attempt)
  if (!previous?.size) {
    tabs?.delete(attempt.tabId ?? '')
  }
  attempt.revision++
  attempt.tabId = tabId
  attempt.leafId = leafId
  const current = tabs?.get(tabId) ?? new Set()
  current.add(attempt)
  tabs?.set(tabId, current)
}

export function cancelLocalLegacyTerminalRestores(
  authority: LegacyTerminalIdentityClaims | undefined,
  workspace: string,
  fence: WorktreePtyHostFence
): void {
  if (
    authority &&
    !fence.resolvedConnectionId &&
    !fence.resolvedRuntimeEnvironmentId &&
    authority.isLocalWorkspace(workspace)
  ) {
    closeLegacyTerminalRestores(authority, workspace)
  }
}

export function transferLegacyTerminalRestores(
  authority: LegacyTerminalIdentityClaims,
  workspace: string,
  sourceTab: string,
  destinationTab: string,
  leafId: string,
  id: string,
  incarnation: string | undefined
): () => void {
  const tabs = attemptsByAuthority
    .get(authority)
    ?.get(normalizeWorkspaceSessionKeyToWorkspaceId(workspace))
  const moved: { attempt: LegacyTerminalRestoreAttempt; revision: number }[] = []
  for (const attempt of tabs?.get(sourceTab) ?? []) {
    if (
      attempt.closed ||
      attempt.leafId !== leafId ||
      (attempt.originalId !== id && attempt.selectedId !== id) ||
      (attempt.originalId === id && attempt.originalIncarnation !== incarnation)
    ) {
      continue
    }
    locateLegacyTerminalRestore(authority, attempt, destinationTab, leafId)
    moved.push({ attempt, revision: attempt.revision })
  }
  return () => {
    for (const { attempt, revision } of moved) {
      if (attempt.revision === revision && !attempt.closed) {
        locateLegacyTerminalRestore(authority, attempt, sourceTab, leafId)
      }
    }
  }
}

export function markLegacyTerminalStopUnverifiable(
  authority: LegacyTerminalIdentityClaims,
  id: string,
  reason: string
): void {
  failedStopByAuthority.get(authority)?.(id, reason)
}
