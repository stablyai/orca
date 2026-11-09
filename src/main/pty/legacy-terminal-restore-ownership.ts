import { selectedTerminalForPane } from './selected-terminal-retirement'
import type { LegacyTerminalIdentityClaims } from '../persistence/loading-store/legacy-terminal-identity-claims'
import type { WorktreePtyHostFence } from '../runtime/workspaces/removal/worktree-pty-host-fence'
import { LocalPtyProvider } from '../providers/local-pty/local-pty-provider'
import { preserveFencedTerminalHistory } from './pty-history-preserving-termination'
import type { TerminalTab } from '../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import type { TerminalSurfaceCloseTarget } from '../../shared/workspace-layout/terminal-surface-close-target'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../shared/workspace-scope'
import type { IPtyProvider, PtySpawnResult } from '../providers/pty-provider-contract'
import { ptyIncarnationById, ptyOwnership } from '../ipc/pty/provider/ownership-state'
import { finishPtyShutdown } from '../ipc/pty/provider/liveness'
import { PtyExitProof } from './process-retirement/pty-exit-proof'
import type { PtyFencedTerminationRequest } from '../../shared/terminal/pty/lifecycle/pty-fenced-termination'

export async function retireScopedTerminal(
  provider: IPtyProvider,
  result: Pick<PtySpawnResult, 'id' | 'incarnationId'>
): Promise<void> {
  if (result.incarnationId && provider instanceof LocalPtyProvider) {
    await provider.shutdown(result.id, {
      immediate: true,
      keepHistory: true,
      expectedIncarnationId: result.incarnationId
    })
    finishPtyShutdown(
      result.id,
      null,
      undefined,
      PtyExitProof.from('shutdown-acknowledged', result.incarnationId)
    )
    return
  }
  if (!result.incarnationId || !provider.killFenced) {
    throw new Error('Cannot verify the closed terminal incarnation')
  }
  const request: PtyFencedTerminationRequest = {
    id: result.id,
    expectedIncarnationId: result.incarnationId,
    requireNoAgentOwner: false,
    requireUnattached: false
  }
  preserveFencedTerminalHistory(request)
  const verdict = await provider.killFenced(request)
  if (verdict.outcome === 'refused') {
    if (verdict.reason === 'replaced') {
      return
    }
    throw new Error(`Closed terminal stop is ${verdict.reason}`)
  }
  finishPtyShutdown(
    result.id,
    null,
    undefined,
    PtyExitProof.from('shutdown-acknowledged', result.incarnationId)
  )
}

export type LegacyTerminalRestoreAttempt = {
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

/** Called by the admitted snapshot's existing membership traversal, before binding publication. */
export function retireRemovedScopedTerminalRow(
  authority: LegacyTerminalIdentityClaims,
  workspace: string,
  row: Pick<TerminalTab, 'id'>,
  prior: WorkspaceSessionState,
  next: WorkspaceSessionState,
  tabSurvives: boolean,
  retainedLeaves?: ReadonlySet<string>
): void {
  if (!authority.isLocalWorkspace(workspace)) {
    return
  }
  const oldLayout = prior.terminalLayoutsByTabId?.[row.id]
  const newLayout = next.terminalLayoutsByTabId?.[row.id]
  if (!tabSurvives && !oldLayout?.root) {
    closeLegacyTerminalRestores(authority, workspace, { kind: 'tab', tabId: row.id })
  }
  if (tabSurvives && oldLayout?.root === newLayout?.root) {
    return
  }
  const present = new Set<string>()
  const collect = (node: NonNullable<typeof newLayout>['root']): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      present.add(node.leafId)
    } else {
      collect(node.first)
      collect(node.second)
    }
  }
  if (tabSurvives) {
    collect(newLayout?.root ?? null)
  }
  const retire = (node: NonNullable<typeof oldLayout>['root']): void => {
    if (!node) {
      return
    }
    if (node.type !== 'leaf') {
      retire(node.first)
      retire(node.second)
      return
    }
    const leafId = node.leafId
    if (present.has(leafId) || retainedLeaves?.has(makePaneKey(row.id, leafId))) {
      return
    }
    closeLegacyTerminalRestores(authority, workspace, { kind: 'pane', tabId: row.id, leafId })
    const id = oldLayout?.ptyIdsByLeafId?.[leafId]
    if (!id || /^\d+$/.test(id)) {
      return
    }
    const incarnationId = prior.terminalPtyIncarnationsByPaneKey?.[makePaneKey(row.id, leafId)]
    if (!incarnationId) {
      return
    }
    try {
      const selected = selectedTerminalForPane(
        authority,
        workspace,
        makePaneKey(row.id, leafId),
        id,
        incarnationId
      )
      if (!selected || ptyIncarnationById.get(id) !== incarnationId) {
        return
      }
      void retireScopedTerminal(selected.provider, selected.result).catch((error: unknown) => {
        if (ptyOwnership.has(id) && ptyIncarnationById.get(id) === incarnationId) {
          failedStopByAuthority.get(authority)?.(id, 'closed restore stop could not be verified')
        }
        console.warn('[pty] closed scoped terminal remains unverified', error)
      })
    } catch {
      /* The owning remote host retains its existing retirement path. */
    }
  }
  retire(oldLayout?.root ?? null)
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
