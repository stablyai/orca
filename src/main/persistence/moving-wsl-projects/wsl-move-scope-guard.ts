// Cache journal fences before handlers run and follow every write; exit proof catches already-admitted spawns.
import { resolve } from 'node:path'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { onWslMoveJournalChange } from './wsl-move-cutover-journal'
import { resolveWslMoveFence, type WslMoveFenceState } from './wsl-move-fence'
import { comparableWslPath, isAtOrUnder } from './wsl-move-comparable-path'
import {
  findProjectHostSetup,
  type ProjectHostSetupTarget
} from '../../../shared/project-host-setup-target'

export type WslMoveProjectRef = { repoId: string } | { folderWorkspaceId: string }

export class WslMoveProjectFencedError extends Error {
  readonly code = 'wsl_move_in_progress'
  /** `hostDistro`: the move already committed, so the host, not a retry, is the way forward. */
  constructor(hostDistro?: string | null) {
    super(
      hostDistro
        ? `This project now runs on its ${hostDistro} WSL host, so its terminals open there. Use it on this computer again to open one here.`
        : 'This project is moving to its WSL host. Try again when the move finishes.'
    )
    this.name = 'WslMoveProjectFencedError'
  }
}

/** Project paths are needed only when journal state is unreadable. */
type ProjectStore = {
  getRepo: (repoId: string) => { path: string } | undefined
  // RuntimeStore exposes only the list.
  getFolderWorkspace?: (folderWorkspaceId: string) => { folderPath: string } | undefined
  getFolderWorkspaces?: () => readonly { id: string; folderPath: string }[]
}

/** Fail closed on unreadable journals: fence WSL projects without hiding source rows. */
type FenceView = { readable: true; state: WslMoveFenceState } | { readable: false }

let loaded: { userDataKey: string; view: FenceView } | null = null

// app.setName can change casing without changing the Windows directory.
export function userDataKey(userDataPath: string): string {
  const resolved = resolve(userDataPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
let stopFollowing: (() => void) | null = null

/** Load before registering handlers or allowing moves. */
export function loadWslMoveFence(userDataPath: string): void {
  loaded = { userDataKey: userDataKey(userDataPath), view: readFence(userDataPath) }
  stopFollowing ??= onWslMoveJournalChange((changedPath) => {
    if (loaded?.userDataKey === userDataKey(changedPath)) {
      loaded.view = readFence(changedPath)
    }
  })
}

export function isWslMoveFenceLoaded(): boolean {
  return loaded !== null
}

export function resetWslMoveFenceForTests(): void {
  stopFollowing?.()
  stopFollowing = null
  loaded = null
}

function readFence(userDataPath: string): FenceView {
  try {
    return { readable: true, state: resolveWslMoveFence(userDataPath) }
  } catch (error) {
    console.warn(
      '[wsl-move] Journal unreadable; keeping WSL projects read-only, sessions unfrozen:',
      error
    )
    return { readable: false }
  }
}

export function wslMoveProjectRefForWorkspace(workspaceId: string): WslMoveProjectRef | null {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    return { folderWorkspaceId: scope.folderWorkspaceId }
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return repoId && repoId !== worktreeId ? { repoId } : null
}

function inScope(scope: WslMoveFenceState['fenced'], ref: WslMoveProjectRef): boolean {
  return 'repoId' in ref
    ? scope.repoIds.has(ref.repoId)
    : scope.folderWorkspaceIds.has(ref.folderWorkspaceId)
}

function projectPath(store: ProjectStore, ref: WslMoveProjectRef): string | undefined {
  if ('repoId' in ref) {
    return store.getRepo(ref.repoId)?.path
  }
  const id = ref.folderWorkspaceId
  if (store.getFolderWorkspace) {
    return store.getFolderWorkspace(id)?.folderPath
  }
  return store.getFolderWorkspaces?.().find((folder) => folder.id === id)?.folderPath
}

/** Block moving/moved projects; unreadable journals require path evidence or conservatively block. */
export function isWslMoveProjectBlocked(
  store: ProjectStore | undefined,
  ref: WslMoveProjectRef | null
): boolean {
  return matchesFence(store, ref, true)
}

/** Already-owned projects are hidden rather than mid-move fenced. */
export function isWslMoveProjectFenced(
  store: ProjectStore | undefined,
  ref: WslMoveProjectRef | null
): boolean {
  return matchesFence(store, ref, false)
}

function matchesFence(
  store: ProjectStore | undefined,
  ref: WslMoveProjectRef | null,
  includeHidden: boolean
): boolean {
  const fence = loaded?.view
  if (!ref || !fence) {
    return false
  }
  if (fence.readable) {
    return inScope(fence.state.fenced, ref) || (includeHidden && inScope(fence.state.hidden, ref))
  }
  return !store || isWslUncPath(projectPath(store, ref) ?? '')
}

export function assertWslMoveProjectWritable(
  store: ProjectStore | undefined,
  ref: WslMoveProjectRef | null
): void {
  if (isWslMoveProjectBlocked(store, ref)) {
    throw new WslMoveProjectFencedError()
  }
}

// Background bookkeeping can defer quietly; user edits must refuse.
const PASSIVE_WORKSPACE_UPDATE_KEYS: ReadonlySet<string> = new Set(['isUnread', 'lastActivityAt'])

export type WslMoveProjectUpdate = Readonly<Record<string, unknown>> & {
  readonly isUnread?: boolean
  readonly lastActivityAt?: number
}

// Activity/read clears are passive; bare isUnread:true is an explicit user edit.
export function isPassiveWorkspaceUpdate(updates: WslMoveProjectUpdate): boolean {
  const keys = Object.keys(updates)
  if (keys.length === 0 || !keys.every((key) => PASSIVE_WORKSPACE_UPDATE_KEYS.has(key))) {
    return false
  }
  return 'lastActivityAt' in updates || updates.isUnread === false
}

/** Only local projects move; same-ID remote projects are independent. */
export function isWslMoveSourceHost(hostId: string | null | undefined): boolean {
  return !hostId || hostId === LOCAL_EXECUTION_HOST_ID
}

export function assertWslMoveRepoWritable(
  store: ProjectStore | undefined,
  repo: { id: string; connectionId?: string | null; executionHostId?: string | null }
): void {
  if (isWslMoveSourceHost(getRepoExecutionHostId(repo))) {
    assertWslMoveProjectWritable(store, { repoId: repo.id })
  }
}

/** Freeze shared projects only mid-move; already-owned repos must not freeze project settings forever. */
export function assertWslMoveReposWritable(
  store: ProjectStore | undefined,
  repoIds: readonly string[]
): void {
  if (repoIds.some((repoId) => isWslMoveProjectFenced(store, { repoId }))) {
    throw new WslMoveProjectFencedError()
  }
}

type HostSetupStore = ProjectStore & {
  getProjects?: () => readonly { id: string; sourceRepoIds: readonly string[] }[]
  getProjectHostSetups?: () => readonly {
    id: string
    projectId: string
    hostId: string
    repoId: string
  }[]
}

/** Local host setups wait for moves of their project checkouts. */
export function assertWslMoveHostSetupWritable(
  store: HostSetupStore | undefined,
  setup: { projectId: string; hostId: string; repoId?: string }
): void {
  if (!isWslMoveSourceHost(setup.hostId)) {
    return
  }
  // A setup's own repo stays blocked after migration; shared project repos block only mid-move.
  if (setup.repoId) {
    assertWslMoveProjectWritable(store, { repoId: setup.repoId })
  }
  const project = store?.getProjects?.().find((entry) => entry.id === setup.projectId)
  assertWslMoveReposWritable(store, project?.sourceRepoIds ?? [])
}

/** Unknown setups defer to the store's not-found handling. */
export function assertWslMoveHostSetupIdWritable(
  store: HostSetupStore | undefined,
  target: ProjectHostSetupTarget
): void {
  const setup = findProjectHostSetup(store?.getProjectHostSetups?.() ?? [], target)
  if (setup) {
    assertWslMoveHostSetupWritable(store, setup)
  }
}

/** Drop passive updates quietly; refuse user edits to blocked projects. */
export function shouldDropWslMoveProjectUpdate(
  store: ProjectStore | undefined,
  ref: WslMoveProjectRef | null,
  updates: WslMoveProjectUpdate
): boolean {
  if (!isWslMoveProjectBlocked(store, ref)) {
    return false
  }
  if (!isPassiveWorkspaceUpdate(updates)) {
    throw new WslMoveProjectFencedError()
  }
  return true
}

export function isWslMoveWorkspaceBlocked(
  store: ProjectStore | undefined,
  workspaceId: string | null | undefined
): boolean {
  return !!workspaceId && isWslMoveProjectBlocked(store, wslMoveProjectRefForWorkspace(workspaceId))
}

/**
 * Whether a new terminal's folder is one a move is taking, whatever workspace it names. A
 * Linux-spelled folder names no distro, so it matches any moving distro. An unreadable journal lets
 * no move reach commit, so it fences nothing here.
 */
export function isWslMoveCwdFenced(cwd: string): boolean {
  const fence = loaded?.view
  if (!fence?.readable) {
    return false
  }
  return fence.state.fencedRoots.some(({ distro, roots }) => {
    const path = comparableWslPath(cwd, distro)
    return path !== null && roots.some((root) => isAtOrUnder(path, root))
  })
}

export function isWslMoveProjectSessionFrozen(ref: WslMoveProjectRef | null): boolean {
  const fence = loaded?.view
  return !!ref && !!fence?.readable && inScope(fence.state.sessionFrozen, ref)
}

export function isWslMoveWorkspaceSessionFrozen(workspaceId: string): boolean {
  return isWslMoveProjectSessionFrozen(wslMoveProjectRefForWorkspace(workspaceId))
}

/** Unreadable journals must not silently discard session writes; their visible edit fence already blocks moves. */
export function hasWslMoveFrozenSessions(): boolean {
  const fence = loaded?.view
  if (!fence?.readable) {
    return false
  }
  const { sessionFrozen } = fence.state
  return sessionFrozen.repoIds.size > 0 || sessionFrozen.folderWorkspaceIds.size > 0
}

export function assertWslMoveWorkspaceWritable(
  store: ProjectStore | undefined,
  workspaceId: string | null | undefined
): void {
  if (isWslMoveWorkspaceBlocked(store, workspaceId)) {
    throw new WslMoveProjectFencedError()
  }
}

type HostedRow = { connectionId?: string | null; executionHostId?: string | null }

/** Hide retained local rows for downgrade; same-ID destination-host rows must remain visible. */
export function withoutWslMovedRepos<T extends HostedRow & { id: string }>(repos: T[]): T[] {
  return withoutHidden(repos, (repo) => ({ repoId: repo.id }))
}

export function withoutWslMovedFolderWorkspaces<T extends HostedRow & { id: string }>(
  folderWorkspaces: T[]
): T[] {
  return withoutHidden(folderWorkspaces, (folder) => ({ folderWorkspaceId: folder.id }))
}

function withoutHidden<T extends HostedRow>(rows: T[], toRef: (row: T) => WslMoveProjectRef): T[] {
  const fence = loaded?.view
  if (rows.length === 0 || !fence?.readable) {
    return rows
  }
  const { hidden } = fence.state
  if (hidden.repoIds.size === 0 && hidden.folderWorkspaceIds.size === 0) {
    return rows
  }
  return rows.filter((row) => !isLocalWslMoveRow(row) || !inScope(hidden, toRef(row)))
}

/** The distro whose WSL host owns the project, once a move committed it; null otherwise. */
export function wslMoveHostDistro(ref: WslMoveProjectRef | null): string | null {
  const fence = loaded?.view
  if (!ref || !fence?.readable) {
    return null
  }
  const { hostDistro } = fence.state
  return (
    ('repoId' in ref
      ? hostDistro.repoIds.get(ref.repoId)
      : hostDistro.folderWorkspaceIds.get(ref.folderWorkspaceId)) ?? null
  )
}

export function isWslMoveWorkspaceHostOwned(workspaceId: string): boolean {
  return wslMoveHostDistro(wslMoveProjectRefForWorkspace(workspaceId)) !== null
}

export function isLocalWslMoveRow(row: HostedRow): boolean {
  return !row.connectionId && isWslMoveSourceHost(row.executionHostId)
}
