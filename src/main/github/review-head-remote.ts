import type { IssueSourcePreference } from '../../shared/repo-types'
import type { GhAccountBinding } from '../../shared/github/account-binding'
import { pickPreferredGitRemote } from '../../shared/preferred-git-remote'
import { getDefaultRemote } from '../git/repo'
import { getGitHubApiRepositoryForRemote } from './github-api-repository'

type GitExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>

// Explicit origin matches issue listing; otherwise honor the upstream project's PR namespace.
export async function resolveGitHubReviewHeadRemote(args: {
  repoPath: string
  issueSourcePreference?: IssueSourcePreference
  connectionId?: string | null
  localGitOptions?: { wslDistro?: string; ghAccount?: GhAccountBinding }
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
  // Avoid per-remote identity/auth probes unless multiple remotes make selection ambiguous.
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
  // Without GitHub identity, retain transport-specific remote selection.
  if (args.connectionId) {
    return pickPreferredGitRemote(remotes)
  }
  return getDefaultRemote(args.repoPath, args.localGitOptions ?? {}, remotes)
}
