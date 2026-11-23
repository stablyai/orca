import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/file-access/cross-platform-path'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../shared/execution-host/execution-host'
import { isWslUncPath, parseWslUncPath, toWindowsWslPath } from '../../shared/file-access/wsl-paths'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { getCallerExecutionHostId } from '../workspace-selection/caller-host-worktree-selection'

const WORKTREE_LIST_LIMIT = 10_000

type ListedWorktree = {
  id: string
  path: string
  hostId?: string
}

type ContainingWorktree = ListedWorktree & {
  relativePath: string
  rank: string
}

export type FileOpenTarget = {
  worktree: string
  relativePath: string
}

// Explicit --worktree stays put; otherwise the longest local worktree containing the absolute path wins.
export async function resolveFileOpenTarget(
  ctx: HandlerContext,
  worktree: string,
  path: string,
  explicitWorktree: boolean
): Promise<FileOpenTarget> {
  if (!isRuntimePathAbsolute(path)) {
    return { worktree, relativePath: path }
  }
  const shown = await ctx.client.call<{ worktree: { path: string } }>('worktree.show', { worktree })
  const rootPath = shown.result.worktree.path
  const relativePath = relativePathInsideRoot(
    rootPath,
    toWorktreeRootPathFlavor(rootPath, ctx.cwd, path)
  )
  if (relativePath === '') {
    throw new RuntimeClientError(
      'invalid_argument',
      'The selected worktree root is a directory, not a file-open target.'
    )
  }
  if (relativePath !== null) {
    return { worktree, relativePath }
  }
  if (explicitWorktree) {
    throw outsideSelectedWorktree(ctx.client.isRemote)
  }
  const listed = await ctx.client.call<{ worktrees: ListedWorktree[]; truncated?: boolean }>(
    'worktree.list',
    { limit: WORKTREE_LIST_LIMIT }
  )
  if (listed.result.truncated === true) {
    throw new RuntimeClientError(
      'invalid_argument',
      'The worktree list was truncated, so this absolute path was not matched to another worktree.',
      {
        nextSteps: ['Pass --worktree path:<workspace> for the workspace that contains the file.']
      }
    )
  }
  return pickContainingWorktree(ctx.cwd, path, listed.result.worktrees)
}

function outsideSelectedWorktree(isRemote: boolean): RuntimeClientError {
  return new RuntimeClientError(
    'invalid_argument',
    'That absolute path is outside the selected worktree.',
    {
      nextSteps: [
        'Pass --worktree path:<workspace> for the registered workspace that contains the file (`orca worktree ps --json`).',
        // A remote call with no --worktree fails before path resolution, so that hint is local-only.
        ...(isRemote
          ? []
          : [
              'Omit --worktree to open an absolute path that is inside another local registered worktree.'
            ])
      ]
    }
  )
}

function pickContainingWorktree(
  cwd: string,
  path: string,
  worktrees: readonly ListedWorktree[]
): FileOpenTarget {
  const callerHostId = getCallerExecutionHostId()
  const matches: ContainingWorktree[] = []
  for (const candidate of worktrees) {
    if (!candidate.id || !candidate.path || !isListedOnCallerHost(candidate.hostId, callerHostId)) {
      continue
    }
    const relativePath = relativePathInsideRoot(
      candidate.path,
      toWorktreeRootPathFlavor(candidate.path, cwd, path)
    )
    if (!relativePath) {
      continue
    }
    matches.push({
      ...candidate,
      relativePath,
      rank: normalizeRuntimePathForComparison(candidate.path)
    })
  }
  const bestLength = Math.max(-1, ...matches.map((match) => match.rank.length))
  const winners = new Map<string, ContainingWorktree>()
  for (const match of matches) {
    if (match.rank.length === bestLength && !winners.has(match.id)) {
      winners.set(match.id, match)
    }
  }
  const chosen = [...winners.values()]
  const winner = chosen[0]
  if (chosen.length === 1 && winner) {
    return { worktree: `id:${winner.id}`, relativePath: winner.relativePath }
  }
  if (chosen.length > 1) {
    const validSelectorForms = chosen.map((match) => `id:${match.id}`)
    throw new RuntimeClientError(
      'selector_ambiguous',
      'More than one registered worktree contains that absolute path. Pass --worktree with one selector.',
      {
        validSelectorForms,
        nextSteps: validSelectorForms.map((selector) => `Pass --worktree ${selector}`)
      }
    )
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'That absolute path is outside every registered worktree.',
    {
      nextSteps: [
        'Pass --worktree path:<workspace> when the file is in a folder workspace or on another host (`orca worktree ps --json`).',
        'Registering a folder with `orca repo add --path <dir> --kind folder` does not select it. Retry with --worktree path:<dir>.'
      ]
    }
  )
}

function isListedOnCallerHost(hostId: string | undefined, callerHostId: string): boolean {
  const rowHostId = hostId ?? LOCAL_EXECUTION_HOST_ID
  return parseExecutionHostId(callerHostId)?.kind === 'ssh'
    ? rowHostId === callerHostId
    : parseExecutionHostId(rowHostId)?.kind !== 'ssh'
}

// Only UNC roots need Linux-path translation; backslash filenames have no equivalent Windows spelling.
function toWorktreeRootPathFlavor(rootPath: string, cwd: string, path: string): string {
  const distro = process.env.WSL_DISTRO_NAME || parseWslUncPath(cwd)?.distro
  if (
    !distro ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    !isWslUncPath(rootPath)
  ) {
    return path
  }
  return toWindowsWslPath(path, distro)
}
