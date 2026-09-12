import type { IssueSourcePreference } from '../../shared/repo-types'
import { pickPreferredGitRemote } from '../../shared/preferred-git-remote'
import { getDefaultRemote } from '../git/repo'
import { getGitHubApiRepositoryForRemote } from './github-api-repository'

type GitExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>

// Why: explicit origin must match issue listing; otherwise hosting identity
// keeps contributor clones on the upstream project's PR namespace.
export async function resolveGitHubReviewHeadRemote(args: {
  repoPath: string
  issueSourcePreference?: IssueSourcePreference
  connectionId?: string | null
  localGitOptions?: { wslDistro?: string }
  gitExec: GitExec
}): Promise<string> {
  const { stdout } = await args.gitExec(['remote'])
  const remotes = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (args.issueSourcePreference === 'origin') {
    if (remotes.includes('origin')) {
      return 'origin'
    }
    throw new Error('Repo has no configured origin remote.')
  }
  // Why: identity probes cost a `remote get-url` (plus a possible gh auth
  // lookup) each; only multi-remote clones are ambiguous enough to need them.
  if (remotes.length > 1) {
    for (const remote of ['upstream', 'origin']) {
      if (!remotes.includes(remote)) {
        continue
      }
      const repository = await getGitHubApiRepositoryForRemote(
        args.repoPath,
        remote,
        args.connectionId ?? null,
        args.localGitOptions ?? {}
      )
      if (repository) {
        return remote
      }
    }
  }
  // Why: when no remote maps to a GitHub project the hosting identity cannot
  // guide the choice; keep the legacy per-transport fallback.
  if (args.connectionId) {
    return pickPreferredGitRemote(remotes)
  }
  return getDefaultRemote(args.repoPath, args.localGitOptions ?? {})
}
