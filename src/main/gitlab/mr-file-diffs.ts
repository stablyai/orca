import type { GitLabMRFile } from '../../shared/gitlab-types'
import { encodedProject } from './project-path-encoding'
import {
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'

/**
 * Counts the added/removed lines in a single GitLab MR file's unified diff,
 * feeding the +N/-N shown in the MR file list. `---`/`+++` are file headers
 * only before the first `@@` hunk; every `+`/`-` line inside a hunk is content.
 * Requires hunk headers: a diff with no `@@` counts zero, so do not reuse this
 * for header-less agent-tool diffs (see `diffFromText` in shared/native-chat-diff).
 *
 * @internal - exposed for tests only.
 */
export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  // Why: `---`/`+++` are file headers only before the first hunk. A removed line
  // whose original text began with `--` (SQL/Lua/Haskell `-- comment`) becomes a
  // diff line `---<content>`, colliding with the `--- a/file` header — so it must
  // be counted once inside a hunk, not skipped.
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk) {
      continue
    }
    if (line.startsWith('+')) {
      additions += 1
    } else if (line.startsWith('-')) {
      deletions += 1
    }
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
      // Why: GitLab deprecated the all-in-one `changes` endpoint in favor of
      // the paginated diffs endpoint; cap the file snapshot at one visible page.
      `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/diffs?per_page=100`
    ],
    glabRepoExecOptions(repoPath, connectionId, localGitOptions)
  )
  const data = JSON.parse(stdout) as Parameters<typeof mapMRFile>[0][]
  return data.map(mapMRFile).filter((file) => file.path)
}
