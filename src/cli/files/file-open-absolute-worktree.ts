import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../shared/file-access/cross-platform-path'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../shared/execution-host/execution-host'
import { basename, dirname, join } from 'node:path'
import { resolveRealPathSync } from '../../shared/file-access/real-path-sync'
import { isWslUncPath, parseWslUncPath, toWindowsWslPath } from '../../shared/file-access/wsl-paths'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { getCallerExecutionHostId } from '../workspace-selection/caller-host-worktree-selection'
import { resolveFilePath } from './file-open-path'

const WORKTREE_LIST_LIMIT = 10_000

type ListedWorktree = {
  id: string
  path: string
  hostId?: string
}

type ContainingWorktree = ListedWorktree & {
  relativePath: string
  rank: string
  realRank: string
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
  // `./` is cwd-relative on local calls; an absolute result is outside the selected worktree.
  const resolved = await resolveFilePath(ctx, worktree, path)
  if (!isRuntimePathAbsolute(resolved)) {
    return { worktree, relativePath: resolved }
  }
  if (explicitWorktree) {
    throw outsideSelectedWorktree(ctx.client.isRemote)
  }
  return listContainingFileOpenTarget(ctx, resolved)
}

// `resolveCurrentWorktreeSelector` throws before this when the cwd is outside every workspace.
export async function resolveAbsoluteFileOpenWithoutCwdWorktree(
  ctx: HandlerContext,
  path: string
): Promise<FileOpenTarget> {
  return listContainingFileOpenTarget(ctx, path)
}

async function listContainingFileOpenTarget(
  ctx: HandlerContext,
  absolutePath: string
): Promise<FileOpenTarget> {
  // Prefix containment treats `..` as a real segment, so collapse dots before the match.
  const path = isRuntimePathAbsolute(absolutePath)
    ? resolveRuntimePath(absolutePath, absolutePath)
    : absolutePath
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

function realPathForComparison(path: string): string | null {
  const existing = resolveRealPathSync(path)
  if (existing) {
    return existing
  }
  const realParent = resolveRealPathSync(dirname(path))
  if (!realParent) {
    return null
  }
  const name = basename(path)
  if (!name || name === '.' || name === '..') {
    return realParent
  }
  return join(realParent, name)
}

function relativePathForCandidate(
  rootPath: string,
  cwd: string,
  path: string,
  realFile: string | null
): string | null {
  const direct = relativePathInsideRoot(rootPath, toWorktreeRootPathFlavor(rootPath, cwd, path))
  if (direct !== null) {
    return direct
  }
  // A ./ path from a physical cwd will not match a worktree registered through a symlink.
  if (!realFile) {
    return null
  }
  const realRoot = resolveRealPathSync(rootPath)
  return realRoot ? relativePathInsideRoot(realRoot, realFile) : null
}

function pickContainingWorktree(
  cwd: string,
  path: string,
  worktrees: readonly ListedWorktree[]
): FileOpenTarget {
  const callerHostId = getCallerExecutionHostId()
  const realFile = callerHostId === LOCAL_EXECUTION_HOST_ID ? realPathForComparison(path) : null
  const matches: ContainingWorktree[] = []
  for (const candidate of worktrees) {
    if (!candidate.id || !candidate.path || !isListedOnCallerHost(candidate.hostId, callerHostId)) {
      continue
    }
    const relativePath = relativePathForCandidate(candidate.path, cwd, path, realFile)
    if (!relativePath) {
      continue
    }
    const realRoot =
      callerHostId === LOCAL_EXECUTION_HOST_ID ? resolveRealPathSync(candidate.path) : null
    matches.push({
      ...candidate,
      relativePath,
      rank: normalizeRuntimePathForComparison(candidate.path),
      realRank: normalizeRuntimePathForComparison(realRoot ?? candidate.path)
    })
  }
  const bestRealLength = Math.max(-1, ...matches.map((match) => match.realRank.length))
  const specific = matches.filter((match) => match.realRank.length === bestRealLength)
  const bestRegisteredLength = Math.max(-1, ...specific.map((match) => match.rank.length))
  const winners = new Map<string, ContainingWorktree>()
  for (const match of specific) {
    if (match.rank.length === bestRegisteredLength && !winners.has(match.id)) {
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
  if (parseExecutionHostId(callerHostId)?.kind === 'ssh') {
    return rowHostId === callerHostId
  }
  // A local absolute path is on this machine. runtime:* can reuse that path string on another filesystem.
  return parseExecutionHostId(rowHostId)?.kind === 'local'
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
