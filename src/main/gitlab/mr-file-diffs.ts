import type { GitLabMRFile } from '../../shared/gitlab-types'
import { encodedProject } from './project-path-encoding'
import {
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'

/** Count unified hunks only; header-less agent diffs need the separate shared/native-chat-diff parser. */
function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  // Inside a hunk ---/+++ are content prefixes, not file headers.
  let inHunk = false
  let cursor = 0
  while (cursor < diff.length) {
    if (diff.startsWith('@@', cursor)) {
      inHunk = true
    } else if (inHunk) {
      const prefix = diff.charCodeAt(cursor)
      if (prefix === 43) {
        additions += 1
      } else if (prefix === 45) {
        deletions += 1
      }
    }
    const newline = diff.indexOf('\n', cursor)
    if (newline === -1) {
      break
    }
    cursor = newline + 1
  }
  return { additions, deletions }
}

function mapMRFile(raw: {
  new_path?: string
  old_path?: string
  diff?: string
  new_file?: boolean
  deleted_file?: boolean
  renamed_file?: boolean
  binary?: boolean
  too_large?: boolean
}): GitLabMRFile {
  const diff = raw.diff ?? ''
  const counts = countDiffLines(diff)
  const status = raw.new_file
    ? 'added'
    : raw.deleted_file
      ? 'removed'
      : raw.renamed_file
        ? 'renamed'
        : 'modified'
  return {
    path: raw.new_path ?? raw.old_path ?? '',
    ...(raw.old_path && raw.old_path !== raw.new_path ? { oldPath: raw.old_path } : {}),
    status,
    additions: counts.additions,
    deletions: counts.deletions,
    isBinary: Boolean(raw.binary || raw.too_large || !diff),
    ...(diff ? { diff } : {})
  }
}

export async function fetchMRFiles(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabMRFile[]> {
  const { stdout } = await glabExecFileAsync(
    [
      'api',
      ...glabHostnameArgs(projectRef, connectionId),
      // GitLab replaces changes with paginated diffs; bound the visible snapshot to one page.
      `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/diffs?per_page=100`
    ],
    glabRepoExecOptions(repoPath, connectionId, localGitOptions)
  )
  const data = JSON.parse(stdout) as Parameters<typeof mapMRFile>[0][]
  return data.map(mapMRFile).filter((file) => file.path)
}
