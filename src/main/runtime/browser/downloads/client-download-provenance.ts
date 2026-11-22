// Which page each paired-desktop download saved in a workspace came from, as this host committed it,
// so a later import can name the file a page downloaded instead of guessing by time.

export type ClientDownloadCommit = {
  workspaceId: string
  browserPageId: string
  workspaceRelativePath: string
  committedAt: number
}

const MAX_RECORDED = 64
const commits: ClientDownloadCommit[] = []

export function recordClientDownloadCommit(commit: ClientDownloadCommit): void {
  commits.push(commit)
  if (commits.length > MAX_RECORDED) {
    commits.shift()
  }
}

export function clientDownloadCommits(
  match: (commit: ClientDownloadCommit) => boolean
): ClientDownloadCommit[] {
  return commits.filter(match)
}
