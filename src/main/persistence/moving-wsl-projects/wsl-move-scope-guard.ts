/**
 * Where the WSL move fence takes effect in this build (design, section 4.3): projects a move is
 * taking are read-only and get no new terminals, and projects the WSL host now owns are not listed.
 * One answer for every IPC and RPC entry point, so no path can edit a project mid-move.
 *
 * Held in memory: loaded at startup, before any handler runs, and reloaded on every journal write,
 * since only this process writes the journal. Spawns and list calls never touch the disk for it.
 * A spawn already past this check when the fence lands is caught by the move itself: the gate runs
 * again under the fence, and the exit proof refuses any live session in scope.
 */
import { resolve } from 'node:path'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { onWslMoveJournalChange } from './wsl-move-cutover-journal'
import { resolveWslMoveFence, type WslMoveFenceState } from './wsl-move-fence'
import {
  findProjectHostSetup,
  type ProjectHostSetupTarget
} from '../../../shared/project-host-setup-target'

export type WslMoveProjectRef = { repoId: string } | { folderWorkspaceId: string }

export class WslMoveProjectFencedError extends Error {
  readonly code = 'wsl_move_in_progress'
  constructor() {
    super('This project is moving to its WSL host. Try again when the move finishes.')
    this.name = 'WslMoveProjectFencedError'
  }
}

/** Only the project paths, read when the journal is unreadable. */
type ProjectStore = {
  getRepo: (repoId: string) => { path: string } | undefined
  // RuntimeStore has only the list.
  getFolderWorkspace?: (folderWorkspaceId: string) => { folderPath: string } | undefined
  getFolderWorkspaces?: () => readonly { id: string; folderPath: string }[]
}

/** An unreadable journal fences every WSL project and hides none: never edit, never lose a row. */
type FenceView = { readable: true; state: WslMoveFenceState } | { readable: false }

let loaded: { userDataKey: string; view: FenceView } | null = null

// `app.setName` can respell the same folder; Windows paths compare case-insensitively.
export function userDataKey(userDataPath: string): string {
  const resolved = resolve(userDataPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
let stopFollowing: (() => void) | null = null

/** Startup, before handlers register. A move must not fence anything until this has run. */
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

/** The project a terminal's or session's workspace key belongs to. */
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

/**
 * True while a move is taking the project, or once the WSL host owns it. Only an unreadable journal
 * needs the store, to tell WSL projects apart; with none to ask, it blocks.
 */
export function isWslMoveProjectBlocked(
  store: ProjectStore | undefined,
  ref: WslMoveProjectRef | null
): boolean {
  return matchesFence(store, ref, true)
}

/** Only while a move is taking the project; one the WSL host already owns is not fenced. */
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

// Background bookkeeping a move drops quietly; anything else is a user edit and is refused.
const PASSIVE_WORKSPACE_UPDATE_KEYS: ReadonlySet<string> = new Set(['isUnread', 'lastActivityAt'])

/** A worktree meta or folder workspace patch, as the edit entry points receive it. */
export type WslMoveProjectUpdate = Readonly<Record<string, unknown>> & {
  readonly isUnread?: boolean
  readonly lastActivityAt?: number
}

// Activity carries lastActivityAt and a read clears unread; a bare `isUnread: true` is a user's mark-unread.
export function isPassiveWorkspaceUpdate(updates: WslMoveProjectUpdate): boolean {
  const keys = Object.keys(updates)
  if (keys.length === 0 || !keys.every((key) => PASSIVE_WORKSPACE_UPDATE_KEYS.has(key))) {
    return false
  }
  return 'lastActivityAt' in updates || updates.isUnread === false
}

/** A move only takes local projects; the same repo id on another host is a different project. */
export function isWslMoveSourceHost(hostId: string | null | undefined): boolean {
  return !hostId || hostId === LOCAL_EXECUTION_HOST_ID
}

/** For entry points that already hold the repo row, which names its host. */
export function assertWslMoveRepoWritable(
  store: ProjectStore | undefined,
  repo: { id: string; connectionId?: string | null; executionHostId?: string | null }
): void {
  if (isWslMoveSourceHost(getRepoExecutionHostId(repo))) {
    assertWslMoveProjectWritable(store, { repoId: repo.id })
  }
}

/**
 * A catalog project spans its source repos; a move taking any of them freezes the whole project.
 * A repo the WSL host already owns does not, or the project's settings would freeze for good.
 */
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

/** A setup on this machine edits its project's local checkouts, so it waits out a move taking one. */
export function assertWslMoveHostSetupWritable(
  store: HostSetupStore | undefined,
  setup: { projectId: string; hostId: string; repoId?: string }
): void {
  if (!isWslMoveSourceHost(setup.hostId)) {
    return
  }
  // The setup's own repo stays frozen once the host owns it; shared project repos only mid-move.
  if (setup.repoId) {
    assertWslMoveProjectWritable(store, { repoId: setup.repoId })
  }
  const project = store?.getProjects?.().find((entry) => entry.id === setup.projectId)
  assertWslMoveReposWritable(store, project?.sourceRepoIds ?? [])
}

/** For update and delete; an unknown setup is left to the store's own not-found. */
export function assertWslMoveHostSetupIdWritable(
  store: HostSetupStore | undefined,
  target: ProjectHostSetupTarget
): void {
  const setup = findProjectHostSetup(store?.getProjectHostSetups?.() ?? [], target)
  if (setup) {
    assertWslMoveHostSetupWritable(store, setup)
  }
}

/** True when the caller should drop the update quietly; throws for a user edit to a blocked project. */
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

/** True once a move has paused the project: its session must stay as the quiesce left it. */
export function isWslMoveProjectSessionFrozen(ref: WslMoveProjectRef | null): boolean {
  const fence = loaded?.view
  return !!ref && !!fence?.readable && inScope(fence.state.sessionFrozen, ref)
}

export function isWslMoveWorkspaceSessionFrozen(workspaceId: string): boolean {
  return isWslMoveProjectSessionFrozen(wslMoveProjectRefForWorkspace(workspaceId))
}

/**
 * Whether any move has a frozen session; lets the hot write path skip the per-workspace scan.
 * An unreadable journal freezes nothing: the edit fence already refuses visibly, and no move can
 * proceed without a readable journal, so freezing would only discard sessions silently.
 */
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

/**
 * Rows the WSL host owns stay in the profile for a downgrade; this build lists the host instead.
 * Only local rows: after a move the host's own row carries the same id and must stay listed.
 */
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

/** A row on this machine, the only kind a move takes. */
export function isLocalWslMoveRow(row: HostedRow): boolean {
  return !row.connectionId && isWslMoveSourceHost(row.executionHostId)
}
