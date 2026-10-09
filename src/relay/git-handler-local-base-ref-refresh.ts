import type { GitExec } from './git-handler-ops'
import { readRelayWorktreeList } from './git-handler-worktree-ops'
import type { GitCapabilityCache } from '../shared/git-capability-cache'
import { createCoalescingKeyedRunner } from '../shared/coalescing-keyed-runner'
import {
  fastForwardLocalBaseBranch,
  inspectLocalBaseBranch,
  type LocalBaseBranchFastForwardOutcome,
  type LocalBaseBranchGit,
  type LocalBaseBranchInspection,
  type LocalBaseBranchRefs
} from '../shared/worktree/local-base-branch-fast-forward'

// Why: the host owns this; one run per branch at a time here also serializes creates from every client of this relay.
const runPerLocalBaseBranch = createCoalescingKeyedRunner<LocalBaseBranchFastForwardOutcome>()

export async function refreshLocalBaseRefForWorktreeCreateOp(
  git: GitExec,
  params: Record<string, unknown>,
  capabilities: GitCapabilityCache
): Promise<LocalBaseBranchFastForwardOutcome> {
  const refs = await readLocalBaseBranchRefs(git, params)
  const host = relayLocalBaseBranchGit(git, capabilities)
  return runPerLocalBaseBranch(`${refs.repoPath}\0${refs.fullRef}`, refs.remoteTrackingRef, () =>
    fastForwardLocalBaseBranch(host, refs)
  )
}

export async function inspectLocalBaseRefForWorktreeCreateOp(
  git: GitExec,
  params: Record<string, unknown>,
  capabilities: GitCapabilityCache
): Promise<LocalBaseBranchInspection> {
  const refs = await readLocalBaseBranchRefs(git, params)
  return inspectLocalBaseBranch(relayLocalBaseBranchGit(git, capabilities), refs)
}

async function readLocalBaseBranchRefs(
  git: GitExec,
  params: Record<string, unknown>
): Promise<LocalBaseBranchRefs> {
  const { repoPath, fullRef, remoteTrackingRef } = params
  if (
    typeof repoPath !== 'string' ||
    typeof fullRef !== 'string' ||
    typeof remoteTrackingRef !== 'string'
  ) {
    throw new Error('Invalid local base ref refresh request.')
  }
  if (!fullRef.startsWith('refs/heads/') || !remoteTrackingRef.startsWith('refs/remotes/')) {
    throw new Error('Invalid local base ref refresh refs.')
  }
  await git(['check-ref-format', fullRef], repoPath)
  await git(['check-ref-format', remoteTrackingRef], repoPath)
  return { repoPath, fullRef, remoteTrackingRef }
}

function relayLocalBaseBranchGit(
  git: GitExec,
  capabilities: GitCapabilityCache
): LocalBaseBranchGit {
  return {
    exec: (args, cwd) => git(args, cwd),
    listWorktrees: (repoPath) => readRelayWorktreeList(git, repoPath, capabilities)
  }
}
