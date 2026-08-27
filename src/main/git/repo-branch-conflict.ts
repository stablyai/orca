import { listRemoteNames, resolveLocalBranchName } from './repo-base-ref-search'
import { gitExecOptions, type LocalGitExecOptions } from './repo-default-base-ref'
import { gitExecFileAsync } from './runner'

export type BranchConflictKind = 'local' | 'remote'

/** Whether `ref` resolves in the repository at `path`. */
async function hasGitRefAsync(
  path: string,
  ref: string,
  options: LocalGitExecOptions = {}
): Promise<boolean> {
  try {
    await gitExecFileAsync(['rev-parse', '--verify', ref], gitExecOptions(path, options))
    return true
  } catch {
    return false
  }
}

/**
 * Whether `branchName` is already taken, and by what. Only refs under a configured
 * remote count as remote conflicts; `allowedBaseRef` exempts the ref being branched from.
 */
export async function getBranchConflictKind(
  path: string,
  branchName: string,
  allowedBaseRef?: string,
  options: LocalGitExecOptions = {}
): Promise<BranchConflictKind | null> {
  if (await hasGitRefAsync(path, `refs/heads/${branchName}`, options)) {
    return 'local'
  }

  try {
    const remoteNames = (await listRemoteNames(path, options)).sort((a, b) => b.length - a.length)
    const { stdout } = await gitExecFileAsync(
      ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
      gitExecOptions(path, options)
    )
    const hasRemoteConflict = stdout.split('\n').some((ref) => {
      const trimmed = ref.trim()
      if (isAllowedRemoteBaseRef(trimmed, allowedBaseRef)) {
        return false
      }
      const shortRef = trimmed.replace(/^refs\/remotes\//, '')
      // Why: a ref under a prefix no configured remote owns tracks nothing — a
      // hand-planted ref, or a fork remote that was removed — so it cannot collide
      // with a new local branch. Ref *display* still resolves those leniently.
      if (!remoteNames.some((candidate) => shortRef.startsWith(`${candidate}/`))) {
        return false
      }
      return resolveLocalBranchName(trimmed, shortRef, remoteNames) === branchName
    })

    return hasRemoteConflict ? 'remote' : null
  } catch {
    return null
  }
}

/** The one remote ref a caller may branch from without it counting as a conflict. */
function isAllowedRemoteBaseRef(refName: string, allowedBaseRef: string | undefined): boolean {
  if (!allowedBaseRef) {
    return false
  }
  const normalizedAllowedRef = allowedBaseRef.startsWith('refs/remotes/')
    ? allowedBaseRef
    : `refs/remotes/${allowedBaseRef}`
  return refName === normalizedAllowedRef
}
