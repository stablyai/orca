import { resolve as resolvePath } from 'node:path'
import type { RuntimeWorktreeListResult } from '../shared/runtime-types'
import type { FolderWorkspace } from '../shared/folder-workspace-types'
import { isPathInsideOrEqual } from '../shared/cross-platform-path'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../shared/execution-host'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'
import {
  getCallerExecutionHostId,
  isOnCallerHost,
  resolveCallerPaneWorktreeSelector,
  selectEnclosingWorktreeSelectionOnHost,
  type HostScopedWorktreeSelection
} from './caller-host-worktree-selection'

export function assertLocalCwdWorktreeSelector(selector: string, client: RuntimeClient): void {
  if (!client.isRemote) {
    return
  }
  // Why: a paired CLI's cwd belongs to the client machine, not the runtime
  // server, so cwd-derived worktree selectors are only valid locally.
  throw new RuntimeClientError(
    'invalid_argument',
    `${selector} is a local cwd shortcut and cannot be resolved against a remote runtime. Pass an explicit server-side worktree selector such as identity:<identity>, id:<repo-id>::<path>, name:<displayName>, branch:<branch>, issue:<number>, or path:<absolute-server-path>.`
  )
}

type EnclosingWorkspace = { selector: string; path: string }

// Why: the folder catalog spans every paired host and the same path can exist on two of them;
// the daemon's folder rows carry their SSH pin in `connectionId` only.
function isFolderOnCallerHost(folder: FolderWorkspace, callerHostId: ExecutionHostId): boolean {
  return isOnCallerHost(
    { hostId: getConnectionExecutionHostId(folder.connectionId?.trim()) },
    callerHostId
  )
}

function findDeepestEnclosingWorkspace(
  workspaces: readonly EnclosingWorkspace[],
  currentPath: string
): string | undefined {
  let enclosingSelector: string | undefined
  let enclosingPathLength = -1
  for (const workspace of workspaces) {
    const workspacePath = resolvePath(workspace.path)
    if (
      !isPathInsideOrEqual(workspacePath, currentPath) ||
      workspacePath.length <= enclosingPathLength
    ) {
      continue
    }
    enclosingSelector = workspace.selector
    enclosingPathLength = workspacePath.length
  }
  return enclosingSelector
}

export async function resolveCurrentWorktreeSelector(
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  return (await resolveCurrentWorktreeSelection(cwd, client)).selector
}

export async function resolveCurrentWorktreeSelection(
  cwd: string,
  client: RuntimeClient
): Promise<HostScopedWorktreeSelection> {
  assertLocalCwdWorktreeSelector('current', client)

  const worktrees = await client.call<RuntimeWorktreeListResult>('worktree.list', {
    limit: 10_000
  })
  // Why: users expect "active/current" to mean the enclosing managed worktree
  // even from nested subdirectories. Resolve to the concrete runtime row here:
  // duplicate repo registrations can expose the same Git worktree path, and a
  // path selector would throw selector_ambiguous after losing the repo id.
  const callerHostId = getCallerExecutionHostId()
  const selection = selectEnclosingWorktreeSelectionOnHost(
    worktrees.result.worktrees,
    cwd,
    callerHostId,
    process.env.ORCA_WORKTREE_ID
  )
  if (selection) {
    return selection
  }

  // Why only once no worktree claims the directory: a Folder Workspace is a folder that groups
  // git worktrees, so any worktree match is already the deeper of the two, and the catalog read
  // is paid only where this used to fail outright.
  const currentPath = resolvePath(cwd)
  const folders = await client.call<{ folderWorkspaces: FolderWorkspace[] }>('folderWorkspace.list')
  const enclosingFolder = findDeepestEnclosingWorkspace(
    folders.result.folderWorkspaces
      .filter((folder) => isFolderOnCallerHost(folder, callerHostId))
      .map((folder) => ({
        selector: folderWorkspaceKey(folder.id),
        path: folder.folderPath
      })),
    currentPath
  )
  if (!enclosingFolder) {
    throw new RuntimeClientError(
      'selector_not_found',
      `No Orca-managed workspace contains the current directory: ${currentPath}`
    )
  }
  return { selector: enclosingFolder, worktreeId: enclosingFolder }
}

/**
 * The workspace Orca stamped into the terminal this CLI was invoked from, or undefined outside one.
 *
 * Why `id:` for a git worktree: a bare worktree id is also matched against paths and branches, so
 * only the explicit form narrows to the repo that owns it. A folder workspace key is already
 * unambiguous and is the form the runtime's folder resolvers accept.
 */
export async function getOrcaTerminalWorkspaceSelector(
  client: RuntimeClient
): Promise<string | undefined> {
  const worktreeId = process.env.ORCA_WORKTREE_ID?.trim()
  if (worktreeId?.startsWith('folder:')) {
    return worktreeId
  }
  if (worktreeId) {
    const scoped =
      getCallerExecutionHostId() === LOCAL_EXECUTION_HOST_ID
        ? `id:${worktreeId}`
        : await resolveCallerPaneWorktreeSelector(worktreeId, client)
    if (scoped) {
      return scoped
    }
  }
  const workspaceId = process.env.ORCA_WORKSPACE_ID?.trim()
  return workspaceId?.startsWith('folder:') ? workspaceId : undefined
}

/**
 * The workspace a command targets when the caller named none.
 *
 * Why the terminal environment outranks cwd: Orca stamps every terminal it spawns with the
 * workspace that owns it, and that is the workspace the caller means — a Folder Workspace root
 * matches no git worktree at all, and an agent that has cd'd into a child repo still speaks for
 * the workspace its terminal belongs to.
 */
export async function resolveCallerWorkspaceSelector(
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  assertLocalCwdWorktreeSelector('current', client)
  return (
    (await getOrcaTerminalWorkspaceSelector(client)) ??
    (await resolveCurrentWorktreeSelector(cwd, client))
  )
}

/** The workspace stamp Orca put in this terminal, even when it names nothing the CLI can resolve. */
function getOrcaTerminalWorkspaceStamp(): string | undefined {
  return process.env.ORCA_WORKTREE_ID?.trim() || process.env.ORCA_WORKSPACE_ID?.trim() || undefined
}

/** The same default, for commands that may run unscoped rather than fail. */
export async function resolveOptionalCallerWorkspaceSelector(
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  if (client.isRemote) {
    return undefined
  }
  try {
    return await resolveCallerWorkspaceSelector(cwd, client)
  } catch (error) {
    const terminalWorkspace = getOrcaTerminalWorkspaceStamp()
    if (!terminalWorkspace) {
      // Not inside a managed workspace — no filter
      return undefined
    }
    // Why: running unscoped from an Orca terminal hands the command to whichever workspace the
    // app has focused, so an agent silently drives someone else's screen. Refuse instead.
    throw new RuntimeClientError(
      'selector_not_found',
      `This terminal belongs to Orca workspace ${terminalWorkspace}, which could not be resolved: ${error instanceof Error ? error.message : String(error)}. Pass an explicit --worktree selector, or --worktree all to run unscoped.`
    )
  }
}
