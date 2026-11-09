import { resolve as resolvePath } from 'node:path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import { resolveRealPathSync } from '../shared/real-path-sync'

// One CLI process is one command, so the folder prefilter and ranking share each resolution.
const realPaths = new Map<string, string>()

/** A local path with symlinks resolved; a path that no longer exists keeps its lexical spelling. */
function realPathOf(lexical: string): string {
  let real = realPaths.get(lexical)
  if (real === undefined) {
    real = resolveRealPathSync(lexical) ?? lexical
    realPaths.set(lexical, real)
  }
  return real
}

/**
 * Whether a workspace path contains cwd, and its comparison key for ranking. Paths on the caller's
 * own filesystem compare by filesystem identity, so any symlink alias matches; a path on another
 * host, or whose host is unknown, is never resolved here and compares as written.
 */
export function createCwdContainment(
  cwd: string,
  callerHostId: ExecutionHostId
): (path: string, onCallerFilesystem: boolean) => string | null {
  const lexicalCwd = resolvePath(cwd)
  const local = callerHostId === LOCAL_EXECUTION_HOST_ID
  const realCwd = local ? realPathOf(lexicalCwd) : lexicalCwd
  return (path, onCallerFilesystem) => {
    const lexical = resolvePath(path)
    const real = local && onCallerFilesystem ? realPathOf(lexical) : lexical
    return isPathInsideOrEqual(real, realCwd) || isPathInsideOrEqual(lexical, lexicalCwd)
      ? normalizeRuntimePathForComparison(real)
      : null
  }
}

/** Unstamped rows belong to the answering Orca, as the caller-host rule treats them. */
export function isOnCallerFilesystem(row: {
  hostId?: string | null
  hostUnresolved?: true
}): boolean {
  return !row.hostUnresolved && (!row.hostId || row.hostId === LOCAL_EXECUTION_HOST_ID)
}
