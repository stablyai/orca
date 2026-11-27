import { resolve as resolvePath } from 'node:path'
import type { RuntimeWorktreeRecord } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import {
  isRuntimePathAbsolute,
  relativePathInsideRoot
} from '../../shared/file-access/cross-platform-path'
import { isWslUncPath, parseWslUncPath, toWindowsWslPath } from '../../shared/file-access/wsl-paths'
import { resolveRealPathSync } from '../../shared/file-access/real-path-sync'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host/execution-host'
import { getCallerExecutionHostId } from '../workspace-selection/caller-host-worktree-selection'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'

// Only UNC roots need Linux-path translation; backslash filenames have no equivalent Windows spelling.
function toWorktreeRootPathFlavor(rootPath: string, cwd: string, path: string): string {
  // Interop may omit WSL_DISTRO_NAME; the launcher's UNC cwd also identifies the caller's distro.
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

function worktreeRootTargetError(): RuntimeClientError {
  return new RuntimeClientError(
    'invalid_argument',
    'The selected worktree root is a directory, not a file-open target.'
  )
}

// cwd may be the physical spelling while a registered root keeps a symlinked one.
function relativePathInsideRealRoot(
  rootPath: string,
  cwd: string,
  typedPath: string
): string | null {
  // An SSH caller's cwd names a directory on its own host, not this filesystem.
  if (getCallerExecutionHostId() !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const realRoot = resolveRealPathSync(rootPath)
  const realCwd = resolveRealPathSync(cwd)
  return realRoot && realCwd
    ? relativePathInsideRoot(realRoot, resolvePath(realCwd, typedPath))
    : null
}

// `./` and `.\` (PowerShell completion) are cwd-relative; the runtime rejects `.` segments.
const CWD_RELATIVE_PREFIX = /^\.(?:[\\/]|$)/

export async function resolveFilePath(
  ctx: HandlerContext,
  worktree: string,
  typedPath: string
): Promise<string> {
  const cwdRelative = CWD_RELATIVE_PREFIX.test(typedPath)
  if (cwdRelative && ctx.client.isRemote) {
    // The client cwd can't locate server files, so anchor remote paths at the worktree root.
    const relativePath = typedPath.replace(/^(?:\.[\\/]+)+/, '')
    if (relativePath === '' || relativePath === '.') {
      throw worktreeRootTargetError()
    }
    return relativePath
  }
  const path = cwdRelative ? resolvePath(ctx.cwd, typedPath) : typedPath
  if (!isRuntimePathAbsolute(path)) {
    return path
  }
  // Relativize only paths inside the worktree; leave others for the runtime guard.
  const result = await ctx.client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree
  })

  const rootPath = result.result.worktree.path
  const relativePath =
    relativePathInsideRoot(rootPath, toWorktreeRootPathFlavor(rootPath, ctx.cwd, path)) ??
    (cwdRelative ? relativePathInsideRealRoot(rootPath, ctx.cwd, typedPath) : null)
  if (relativePath === '') {
    throw worktreeRootTargetError()
  }
  return relativePath ?? path
}
