import { basename, dirname, resolve as resolvePath } from 'node:path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import { resolveRealPathSync } from '../main/git/repo-git-marker-scan'

function ancestorNames(path: string): Set<string> {
  const names = new Set<string>()
  for (let current = path; dirname(current) !== current; current = dirname(current)) {
    names.add(basename(current))
  }
  return names
}

/**
 * Whether a workspace path contains cwd, and its comparison key for ranking. On the caller's own
 * filesystem paths compare by filesystem identity, so /tmp and /private/tmp aliases match; another
 * host's paths are never resolved here.
 */
export function createCwdContainment(
  cwd: string,
  callerHostId: ExecutionHostId
): (path: string, hostId?: string | null) => string | null {
  const lexicalCwd = resolvePath(cwd)
  if (callerHostId !== LOCAL_EXECUTION_HOST_ID) {
    return (path) =>
      isPathInsideOrEqual(resolvePath(path), lexicalCwd)
        ? normalizeRuntimePathForComparison(resolvePath(path))
        : null
  }
  const realCwd = resolveRealPathSync(lexicalCwd) ?? lexicalCwd
  // An alias of an ancestor ends in an ancestor's name; only those rows pay for a realpath.
  const names = new Set([...ancestorNames(lexicalCwd), ...ancestorNames(realCwd)])
  return (path, hostId) => {
    const lexical = resolvePath(path)
    const onThisFilesystem = !hostId || hostId === LOCAL_EXECUTION_HOST_ID
    if (!onThisFilesystem || !names.has(basename(lexical))) {
      return isPathInsideOrEqual(lexical, lexicalCwd)
        ? normalizeRuntimePathForComparison(lexical)
        : null
    }
    // A path that no longer exists keeps its lexical spelling.
    const real = resolveRealPathSync(lexical) ?? lexical
    return isPathInsideOrEqual(real, realCwd) || isPathInsideOrEqual(lexical, lexicalCwd)
      ? normalizeRuntimePathForComparison(real)
      : null
  }
}
