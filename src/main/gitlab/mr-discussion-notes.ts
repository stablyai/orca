import type { MRComment } from '../../shared/gitlab-types'
import { viewerAuthorship } from '../source-control/comment-viewer-authorship'
import { encodedProject } from './project-path-encoding'
import {
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'

// Flatten discussion notes for the conversation, excluding system-generated activity.

type GitLabRawNote = {
  id?: number
  body?: string
  author?: { username?: string | null; avatar_url?: string | null; state?: string } | null
  created_at?: string
  system?: boolean
  resolvable?: boolean
  resolved?: boolean
  position?: { new_path?: string; new_line?: number; old_line?: number } | null
}

export type GitLabRawDiscussion = {
  id?: string
  individual_note?: boolean
  notes?: GitLabRawNote[]
}

function flattenDiscussions(
  discussions: GitLabRawDiscussion[],
  viewerUsername: string | null
): MRComment[] {
  const out: MRComment[] = []
  for (const discussion of discussions) {
    const notes = discussion.notes ?? []
    for (const note of notes) {
      if (note.system === true) {
        continue
      }
      out.push({
        id: note.id ?? 0,
        author: note.author?.username ?? 'unknown',
        authorAvatarUrl: note.author?.avatar_url ?? '',
        body: note.body ?? '',
        createdAt: note.created_at ?? '',
        url: '',
        isBot: note.author?.state === 'bot',
        ...viewerAuthorship(note.author?.username, viewerUsername),
        ...(discussion.id ? { threadId: discussion.id } : {}),
        ...(note.resolvable === true ? { isResolved: note.resolved === true } : {}),
        ...(note.position?.new_path ? { path: note.position.new_path } : {}),
        ...(typeof note.position?.new_line === 'number' ? { line: note.position.new_line } : {})
      })
    }
  }
  return out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
}

export async function fetchDiscussionComments(
  repoPath: string,
  projectRef: ProjectRef,
  type: 'issue' | 'mr',
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<MRComment[]> {
  const resource = type === 'mr' ? 'merge_requests' : 'issues'
  const hostArgs = glabHostnameArgs(projectRef, connectionId)
  const options = glabRepoExecOptions(repoPath, connectionId, localGitOptions)
  const [{ stdout }, viewerUsername] = await Promise.all([
    glabExecFileAsync(
      [
        'api',
        ...hostArgs,
        // Bound detail loads to a recent page rather than retaining every historic discussion.
        `projects/${encodedProject(projectRef.path)}/${resource}/${iid}/discussions?per_page=100`
      ],
      options
    ),
    // Notes carry no authorship flag, so ask the same host and account who is reading. Uncached: glab can switch accounts.
    glabExecFileAsync(['api', ...hostArgs, 'user'], options)
      .then((user) => (JSON.parse(user.stdout) as { username?: string | null }).username ?? null)
      .catch(() => null)
  ])
  return flattenDiscussions(JSON.parse(stdout) as GitLabRawDiscussion[], viewerUsername)
}
