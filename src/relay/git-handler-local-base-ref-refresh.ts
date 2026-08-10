import type { GitExec } from './git-handler-ops'
import { areRelayWorktreePathsEqual, readRelayWorktreeList } from './git-handler-worktree-ops'
import type { GitCapabilityCache } from '../shared/git-capability-cache'
import { WORKTREE_CREATE_TIMEOUT_MAX_MS } from '../shared/worktree-create-timeouts'

class RelayWorktreeCreateRefreshTimeoutError extends Error {
  constructor() {
    super('Worktree base ref refresh timed out.')
    this.name = 'RelayWorktreeCreateRefreshTimeoutError'
  }
}

function getErrorText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '')
  }
  return String(error)
}

function isGitCommandTimeout(error: unknown): boolean {
  return (
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      String((error as { code?: unknown }).code) === 'ETIMEDOUT') ||
    /\btimed out\b/i.test(getErrorText(error))
  )
}

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
  const timeoutValue = params.timeoutMs
  if (
    timeoutValue !== undefined &&
    (typeof timeoutValue !== 'number' ||
      !Number.isFinite(timeoutValue) ||
      timeoutValue <= 0 ||
      timeoutValue > WORKTREE_CREATE_TIMEOUT_MAX_MS)
  ) {
    throw new Error('Invalid local base ref refresh timeout.')
  }
  const timeout = timeoutValue as number | undefined
  const deadlineAt = timeout === undefined ? undefined : Date.now() + timeout
  const execute: GitExec = async (args, cwd, options) => {
    const remaining = deadlineAt === undefined ? undefined : deadlineAt - Date.now()
    if (remaining !== undefined && remaining <= 0) {
      throw new RelayWorktreeCreateRefreshTimeoutError()
    }
    try {
      if (remaining === undefined && options === undefined) {
        return await git(args, cwd)
      }
      return await git(args, cwd, {
        ...options,
        ...(remaining === undefined ? {} : { timeout: remaining })
      })
    } catch (error) {
      if (
        error instanceof RelayWorktreeCreateRefreshTimeoutError ||
        (deadlineAt !== undefined && (isGitCommandTimeout(error) || Date.now() >= deadlineAt))
      ) {
        throw new RelayWorktreeCreateRefreshTimeoutError()
      }
      throw error
    }
  }

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

  await execute(['check-ref-format', fullRef], repoPath)
  await execute(['check-ref-format', remoteTrackingRef], repoPath)

  const localOid = await revParseCommit(execute, repoPath, fullRef, 'Local base ref is missing.')
  const remoteOid = await revParseCommit(
    execute,
    repoPath,
    remoteTrackingRef,
    'Remote-tracking base ref is missing.'
  )

  // Why: this RPC mutates refs/worktrees, so the relay repeats main-process
  // safety checks at mutation time to close stale-preflight and direct-call gaps.
  try {
    await execute(['merge-base', '--is-ancestor', localOid, remoteOid], repoPath)
  } catch (error) {
    if (error instanceof RelayWorktreeCreateRefreshTimeoutError) {
      throw error
    }
    throw new Error('Local base ref is not a fast-forward update.')
  }

  const worktrees = await readRelayWorktreeList(execute, repoPath, capabilities)
  const ownerWorktree = worktrees.find((worktree) => worktree.branch === fullRef)
  if (ownerWorktree) {
    if (ownerWorktreePath && !areRelayWorktreePathsEqual(ownerWorktree.path, ownerWorktreePath)) {
      throw new Error('Local base ref is checked out in a different worktree.')
    }
    const { stdout } = await execute(
      ['status', '--porcelain', '--untracked-files=no'],
      ownerWorktree.path
    )
    if (stdout.trim()) {
      throw new Error('Local base ref worktree has tracked changes.')
    }
    if (checkOnly) {
      return
    }
    await execute(['reset', '--hard', remoteOid], ownerWorktree.path)
    return
  }

  // Why: not checked out anywhere — fast-forward the bare ref. The
  // expected-old-OID form is a no-op-safe compare-and-swap if the ref moved
  // since the caller's evaluation snapshot.
  if (checkOnly) {
    return
  }
  await execute(['update-ref', fullRef, remoteOid, localOid], repoPath)
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
