import type { GitExec } from './git-handler-ops'
import { areRelayWorktreePathsEqual, readRelayWorktreeList } from './git-handler-worktree-ops'
import type { GitCapabilityCache } from '../shared/git-capability-cache'

export async function refreshLocalBaseRefForWorktreeCreateOp(
  git: GitExec,
  params: Record<string, unknown>,
  capabilities: GitCapabilityCache
): Promise<void> {
  const repoPath = params.repoPath as string
  const fullRef = params.fullRef as string
  const remoteTrackingRef = params.remoteTrackingRef as string
  const ownerWorktreePath = params.ownerWorktreePath as string | undefined
  const checkOnly = params.checkOnly === true

  if (
    typeof repoPath !== 'string' ||
    typeof fullRef !== 'string' ||
    typeof remoteTrackingRef !== 'string' ||
    (ownerWorktreePath !== undefined && typeof ownerWorktreePath !== 'string')
  ) {
    throw new Error('Invalid local base ref refresh request.')
  }
  if (!fullRef.startsWith('refs/heads/') || !remoteTrackingRef.startsWith('refs/remotes/')) {
    throw new Error('Invalid local base ref refresh refs.')
  }

  await git(['check-ref-format', fullRef], repoPath)
  await git(['check-ref-format', remoteTrackingRef], repoPath)

  const localOid = await revParseCommit(git, repoPath, fullRef, 'Local base ref is missing.')
  const remoteOid = await revParseCommit(
    git,
    repoPath,
    remoteTrackingRef,
    'Remote-tracking base ref is missing.'
  )

  // Why: this RPC mutates refs/worktrees, so the relay repeats main-process
  // safety checks at mutation time to close stale-preflight and direct-call gaps.
  try {
    await git(['merge-base', '--is-ancestor', localOid, remoteOid], repoPath)
  } catch {
    throw new Error('Local base ref is not a fast-forward update.')
  }

  const worktrees = await readRelayWorktreeList(git, repoPath, capabilities)
  const ownerWorktree = worktrees.find((worktree) => worktree.branch === fullRef)
  if (ownerWorktree) {
    if (ownerWorktreePath && !areRelayWorktreePathsEqual(ownerWorktree.path, ownerWorktreePath)) {
      throw new Error('Local base ref is checked out in a different worktree.')
    }
    const { stdout } = await git(
      ['status', '--porcelain', '--untracked-files=no'],
      ownerWorktree.path
    )
    if (stdout.trim()) {
      throw new Error('Local base ref worktree has tracked changes.')
    }
    if (checkOnly) {
      return
    }
    await git(['reset', '--hard', remoteOid], ownerWorktree.path)
    return
  }

  // Why: not checked out anywhere — fast-forward the bare ref. The
  // expected-old-OID form is a no-op-safe compare-and-swap if the ref moved
  // since the caller's evaluation snapshot.
  if (checkOnly) {
    return
  }
  await git(['update-ref', fullRef, remoteOid, localOid], repoPath)
}

async function revParseCommit(
  git: GitExec,
  repoPath: string,
  ref: string,
  missingMessage: string
): Promise<string> {
  const { stdout } = await git(['rev-parse', '--verify', `${ref}^{commit}`], repoPath)
  const oid = stdout.trim()
  if (!oid) {
    throw new Error(missingMessage)
  }
  return oid
}
