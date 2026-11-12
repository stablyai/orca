import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import {
  resolveQualifiedFolderWorkspaceResult,
  type QualifiedFolderHostState
} from '../../../../shared/folder-workspaces/folder-workspace-execution-host'
import { folderIdOfSelector, folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { runtimePathsEqual, type ResolvedWorktree } from './runtime-worktree-path-identity'

/** A selector's match: a repo-backed row, or a folder workspace with its derived host (null when underivable). */
export type WorkspaceSelectorCandidate =
  | { kind: 'worktree'; worktree: ResolvedWorktree }
  | { kind: 'folder'; folder: FolderWorkspace; hostId: ExecutionHostId | null }

export type WorkspaceSelectorChoice = {
  kind: 'worktree' | 'folder workspace'
  hostId: string | null
  path: string
  /** Null when no selector names this row alone, such as a duplicated folder id. */
  selector: string | null
}

export type FolderCatalog = QualifiedFolderHostState<FolderWorkspace> & {
  folderWorkspaces: readonly FolderWorkspace[]
}

/** `matchFolders` (a request opt-in) lets path: and name: match folders beside repo-backed rows;
 * `anyFolderHost` accepts a folder whose host is underivable, as parents do. */
export type WorkspaceSelectorOptions = {
  requireUsableFolderPath?: boolean
  requiredHostId?: ExecutionHostId
  matchFolders?: boolean
  anyFolderHost?: boolean
}

export function folderCatalogOf(
  store: {
    getFolderWorkspaces?: () => FolderWorkspace[]
    getProjectGroups?: () => NonNullable<FolderCatalog['projectGroups']>
    getRepos: () => NonNullable<FolderCatalog['repos']>
  } | null
): FolderCatalog {
  return {
    folderWorkspaces: store?.getFolderWorkspaces?.() ?? [],
    projectGroups: store?.getProjectGroups?.() ?? [],
    repos: store?.getRepos() ?? []
  }
}

/** `folder:<id>` resolved to its one row and host; null for any other selector. */
export function resolveKeyedFolderWorkspace(
  catalog: FolderCatalog,
  selector: string,
  requiredHostId?: ExecutionHostId
): FolderWorkspace | null {
  const folderId = folderIdOfSelector(selector)
  if (folderId === undefined) {
    return null
  }
  // An unscoped key must name one row; a host-scoped lookup may pick that host's copy.
  if (requiredHostId === undefined) {
    assertUniqueFolderWorkspaceId(catalog, folderId, selector)
  }
  const result = resolveQualifiedFolderWorkspaceResult(catalog, folderId, requiredHostId)
  if (result.kind !== 'selected') {
    throw new Error(result.kind === 'missing' ? 'selector_not_found' : 'selector_ambiguous')
  }
  const { workspace, hostId, connectionId } = result.value
  return { ...workspace, executionHostId: hostId, connectionId }
}

/** path: and name: name folder workspaces too; branch:, issue: and identity: stay repo-backed. */
export function matchFolderWorkspaceRows(
  selector: string,
  folders: readonly FolderWorkspace[]
): FolderWorkspace[] {
  if (selector.startsWith('path:')) {
    return folders.filter((folder) => runtimePathsEqual(folder.folderPath, selector.slice(5)))
  }
  if (selector.startsWith('name:')) {
    return folders.filter((folder) => folder.name === selector.slice(5))
  }
  return []
}

export function deriveFolderWorkspaceHost(
  catalog: FolderCatalog,
  folder: FolderWorkspace
): { hostId: ExecutionHostId; connectionId: string | null } | null {
  const result = resolveQualifiedFolderWorkspaceResult(
    { ...catalog, folderWorkspaces: [folder] },
    folder.id
  )
  return result.kind === 'selected'
    ? { hostId: result.value.hostId, connectionId: result.value.connectionId }
    : null
}

export function folderCandidate(
  catalog: FolderCatalog,
  folder: FolderWorkspace
): Extract<WorkspaceSelectorCandidate, { kind: 'folder' }> {
  const host = deriveFolderWorkspaceHost(catalog, folder)
  return {
    kind: 'folder',
    folder: host
      ? { ...folder, executionHostId: host.hostId, connectionId: host.connectionId }
      : folder,
    hostId: host?.hostId ?? null
  }
}

export class WorkspaceSelectorAmbiguousError extends Error {
  readonly code = 'selector_ambiguous'
  constructor(
    message: string,
    readonly data: {
      selector: string
      candidates: WorkspaceSelectorChoice[]
      duplicateFolderId?: string
      nextSteps: string[]
    }
  ) {
    super(message)
  }
}

function choiceLines(choices: readonly WorkspaceSelectorChoice[]): string[] {
  return choices.map(
    (choice) =>
      `  ${choice.kind}  host=${choice.hostId ?? 'unresolved'}  ${choice.path}${choice.selector ? `  --worktree ${choice.selector}` : ''}`
  )
}

/** Refuses a folder id that more than one folder workspace claims; nothing can name one copy. */
export function assertUniqueFolderWorkspaceId(
  catalog: FolderCatalog,
  folderId: string,
  selector: string,
  outcome = 'Nothing was changed.'
): void {
  const rows = catalog.folderWorkspaces.filter((folder) => folder.id === folderId)
  if (rows.length < 2) {
    return
  }
  const candidates = rows.map((folder) => ({
    kind: 'folder workspace' as const,
    hostId: deriveFolderWorkspaceHost(catalog, folder)?.hostId ?? null,
    path: folder.folderPath,
    selector: null
  }))
  const repair = `Remove one of these folder workspaces in the Orca app and add its folder again so it gets its own id.`
  throw new WorkspaceSelectorAmbiguousError(
    [
      `Folder workspace id "${folderId}" belongs to ${rows.length} folder workspaces in this Orca, so no selector can name one of them:`,
      ...choiceLines(candidates),
      `${outcome} ${repair}`
    ].join('\n'),
    { selector, candidates, duplicateFolderId: folderId, nextSteps: [repair] }
  )
}

function choiceOf(
  candidate: WorkspaceSelectorCandidate,
  candidates: readonly WorkspaceSelectorCandidate[],
  catalog: FolderCatalog
): WorkspaceSelectorChoice {
  if (candidate.kind === 'folder') {
    const unique =
      catalog.folderWorkspaces.filter((folder) => folder.id === candidate.folder.id).length === 1
    return {
      kind: 'folder workspace',
      hostId: candidate.hostId,
      path: candidate.folder.folderPath,
      selector: unique ? folderWorkspaceKey(candidate.folder.id) : null
    }
  }
  const { worktree } = candidate
  const sharesId = candidates.some(
    (other) => other !== candidate && other.kind === 'worktree' && other.worktree.id === worktree.id
  )
  return {
    kind: 'worktree',
    hostId: worktree.hostId ?? null,
    path: worktree.path,
    selector: worktree.identity?.key
      ? `identity:${worktree.identity.key}`
      : sharesId
        ? null
        : `id:${worktree.id}`
  }
}

/** One match wins; several refuse with each choice's kind, host, path and selector. */
export function selectWorkspaceCandidate(
  selector: string,
  candidates: readonly WorkspaceSelectorCandidate[],
  catalog: FolderCatalog
): WorkspaceSelectorCandidate {
  if (candidates.length === 0) {
    throw new Error('selector_not_found')
  }
  if (candidates.length === 1) {
    const [only] = candidates
    if (only.kind === 'folder') {
      assertUniqueFolderWorkspaceId(catalog, only.folder.id, selector)
    }
    return only
  }
  const choices = candidates.map((candidate) => choiceOf(candidate, candidates, catalog))
  throw new WorkspaceSelectorAmbiguousError(
    [
      `More than one workspace matches "${selector}". Pass one of these selectors instead:`,
      ...choiceLines(choices)
    ].join('\n'),
    {
      selector,
      candidates: choices,
      nextSteps: ['Run `orca worktree ps --json` to compare the choices.']
    }
  )
}
