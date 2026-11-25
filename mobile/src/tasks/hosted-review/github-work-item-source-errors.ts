export type GitHubSourceOwnerRepo = {
  owner: string
  repo: string
}

export type GitHubSourceErrorEnvelope = {
  sources?: {
    issues: GitHubSourceOwnerRepo | null
    prs?: GitHubSourceOwnerRepo | null
  } | null
  errors?: {
    issues?: {
      message: string
    } | null
  } | null
  issueSourceFellBack?: true
}

export type GitHubIssueSourceError = {
  repoId: string
  repoPath: string
  source: GitHubSourceOwnerRepo
  message: string
}

export type GitHubIssueSourceFallback = {
  repoId: string
  repoPath: string
  repoLabel: string
}

export function extractGitHubIssueSourceError(
  repo: { id: string; path: string },
  envelope: GitHubSourceErrorEnvelope
): GitHubIssueSourceError | null {
  const issueError = envelope.errors?.issues
  const issueSource = envelope.sources?.issues
  if (!issueError || !issueSource) {
    return null
  }
  return {
    repoId: repo.id,
    repoPath: repo.path,
    source: issueSource,
    message: issueError.message
  }
}

export function extractGitHubIssueSourceFallback(
  repo: { id: string; path: string; displayName: string },
  envelope: GitHubSourceErrorEnvelope
): GitHubIssueSourceFallback | null {
  if (envelope.issueSourceFellBack !== true) {
    return null
  }
  const prSource = envelope.sources?.prs
  return {
    repoId: repo.id,
    repoPath: repo.path,
    repoLabel: prSource ? `${prSource.owner}/${prSource.repo}` : repo.displayName
  }
}
