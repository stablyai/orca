import { parseGitRevListAheadBehindCounts } from '../../shared/git-rev-list-output'
import type { LocalBaseRefDriftWarning } from '../../shared/worktree/base-ref-drift-types'
import { gitExecFileAsync } from './runner'
import { resolveLocalWorktreeBaseRef } from './worktree-base-ref-probe'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import { gitExecOptions } from './worktree-operation-options'

function parseRevListDrift(output: string): { ahead: number; behind: number } | null {
  const counts = parseGitRevListAheadBehindCounts(output)
  return counts.status === 'ok' ? { ahead: counts.ahead, behind: counts.behind } : null
}

const LOCAL_BASE_REF_DRIFT_PROBE_TIMEOUT_MS = 10_000

export function baseDriftWarningResult(
  drift: LocalBaseRefDriftWarning | undefined,
  warning: string | undefined
): { warning?: string; localBaseRefDriftWarning?: LocalBaseRefDriftWarning } {
  return drift
    ? {
        warning: [warning, formatLocalBaseRefDriftWarning(drift)].filter(Boolean).join(' '),
        localBaseRefDriftWarning: drift
      }
    : warning
      ? { warning }
      : {}
}

export function formatLocalBaseRefDriftWarning(warning: LocalBaseRefDriftWarning): string {
  return warning.relation === 'diverged'
    ? `Selected base ${warning.baseRef} has ${warning.behind} commit(s) behind and ${warning.ahead} ahead of ${warning.defaultBaseRef}.`
    : `Selected base ${warning.baseRef} is ${warning.behind} commit(s) behind ${warning.defaultBaseRef}.`
}

export async function getLocalBaseRefDriftWarningForWorktreeCreate(
  repoPath: string,
  baseRef: string,
  defaultBaseRef: string,
  options: GitWorktreeExecOptions = {}
): Promise<LocalBaseRefDriftWarning | undefined> {
  if (baseRef === defaultBaseRef || /^[0-9a-f]{7,64}$/i.test(baseRef)) {
    return undefined
  }
  try {
    const qualifiedBaseRef = await resolveLocalWorktreeBaseRef(repoPath, baseRef, options)
    if (!qualifiedBaseRef.startsWith('refs/heads/')) {
      return undefined
    }
    const { stdout } = await gitExecFileAsync(
      ['rev-list', '--left-right', '--count', `${qualifiedBaseRef}...${defaultBaseRef}`],
      gitExecOptions(repoPath, {
        ...options,
        timeout: options.timeout ?? LOCAL_BASE_REF_DRIFT_PROBE_TIMEOUT_MS
      })
    )
    const drift = parseRevListDrift(stdout)
    if (!drift || drift.behind === 0) {
      return undefined
    }
    return {
      baseRef,
      defaultBaseRef,
      ahead: drift.ahead,
      behind: drift.behind,
      relation: drift.ahead > 0 ? 'diverged' : 'behind'
    }
  } catch {
    // A failed advisory probe must never change or block worktree creation.
    return undefined
  }
}
