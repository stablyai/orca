import { runProcess } from '../../../shared/child-process/run-process'

/** B6 — the completion evidence Orca observes for itself.
 *
 *  The worker never tells Orca what HEAD is or whether the tree is clean: this
 *  runs two fixed Git commands on the execution host the worker actually runs
 *  on (native, folder workspace, or the SSH side of a remote session) and
 *  reports what it saw. No caller-supplied shell text is ever executed. */
export type ObservedCompletionEvidence = {
  headSha: string | null
  worktreeClean: boolean
  placement: 'local' | 'folder' | 'ssh'
  /** Why the observation is incomplete, when it is. */
  unavailableReason: string | null
}

const GIT_TIMEOUT_MS = 20_000

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const result = await runProcess({ program: 'git', args, cwd, timeoutMs: GIT_TIMEOUT_MS })
    return result.code === 0 ? result.stdout.trim() : null
  } catch {
    return null
  }
}

export async function observeCompletionEvidence(cwd: string): Promise<ObservedCompletionEvidence> {
  const insideWorkTree = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (insideWorkTree !== 'true') {
    // Why not an error: a folder workspace is a supported placement; it simply
    // cannot produce a SHA-bound receipt, and the gate must say so explicitly.
    return {
      headSha: null,
      worktreeClean: false,
      placement: 'folder',
      unavailableReason: 'Working directory is not a Git worktree.'
    }
  }
  const headSha = await git(cwd, ['rev-parse', 'HEAD'])
  if (!headSha) {
    return {
      headSha: null,
      worktreeClean: false,
      placement: 'local',
      unavailableReason: 'Git HEAD could not be resolved.'
    }
  }
  const status = await git(cwd, ['status', '--porcelain'])
  if (status === null) {
    return {
      headSha,
      worktreeClean: false,
      placement: 'local',
      unavailableReason: 'git status failed; worktree cleanliness is unproven.'
    }
  }
  return {
    headSha,
    worktreeClean: status.length === 0,
    // Why `local` for a remote host too: placement names where the tree lives
    // relative to the process that observed it, and this process runs there.
    placement: 'local',
    unavailableReason: null
  }
}
