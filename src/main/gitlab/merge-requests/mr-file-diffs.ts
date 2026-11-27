import type { GitLabMRFile } from '../../../shared/gitlab/gitlab-types'
import { encodedProject } from '../projects/project-path-encoding'
import { glabHostnameArgs, glabRepoExecOptions } from '../projects/gitlab-project-ref-resolution'
import { glabExecFileAsync } from '../../git/command-runner/hosted-cli/glab-exec-file'
import type { LocalGitExecOptions } from '../projects/gitlab-known-host-probe'
import type { ProjectRef } from '../projects/project-ref-parser'
import { classifyGlabError } from '../requests/glab-error-classification'
import { extractExecError } from '../../git/command-runner/process-capture/exec-error'

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

type RawMRFile = {
  new_path?: string
  old_path?: string
  diff?: string
  new_file?: boolean
  deleted_file?: boolean
  renamed_file?: boolean
  binary?: boolean
  too_large?: boolean
}

function mapMRFile(raw: RawMRFile): GitLabMRFile {
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

// Bound the visible snapshot to one page of GitLab's paginated diffs.
const MR_FILES_PAGE_SIZE = 100
// GitLab before 15.7 lacks the diffs route; skip its 404 once the changes route has worked.
const changesRouteHosts = new Set<string>()

export async function fetchMRFiles(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabMRFile[]> {
  const readJson = async <T>(endpoint: string): Promise<T> => {
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/${endpoint}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    return JSON.parse(stdout)
  }
  const readChanges = async (): Promise<RawMRFile[]> => {
    // The legacy payload is the MR with its file entries under changes; it is not paginated.
    const data = await readJson<{ changes?: RawMRFile[] }>('changes')
    return (data.changes ?? []).slice(0, MR_FILES_PAGE_SIZE)
  }
  let files: RawMRFile[]
  if (changesRouteHosts.has(projectRef.host)) {
    files = await readChanges()
  } else {
    try {
      files = await readJson<RawMRFile[]>(`diffs?per_page=${MR_FILES_PAGE_SIZE}`)
    } catch (error) {
      if (classifyGlabError(extractExecError(error).stderr).type !== 'not_found') {
        throw error
      }
      files = await readChanges()
      changesRouteHosts.add(projectRef.host)
    }
  }
  return files.map(mapMRFile).filter((file) => file.path)
}
