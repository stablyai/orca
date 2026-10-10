import type { MRComment } from '../../shared/gitlab-types'
import { encodedProject } from './project-path-encoding'
import {
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'

// ── Discussion → MRComment flattening ──────────────────────────────
// GitLab returns discussions with nested notes; the dialog renders a
// flat conversation. We drop system notes ("X assigned the MR", auto-
// generated changelog entries) since they aren't user-authored content.

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

export function flattenDiscussions(discussions: GitLabRawDiscussion[]): MRComment[] {
  const out: MRComment[] = []
  for (const discussion of discussions) {
    const notes = discussion.notes ?? []
    for (const note of notes) {
      if (note.system === true) {
        // Why: skip GitLab's auto-generated activity entries — they
        // would dominate a busy MR's conversation tab if rendered.
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
        ...(discussion.id ? { threadId: discussion.id } : {}),
        ...(note.resolvable === true ? { isResolved: note.resolved === true } : {}),
        ...(note.position?.new_path ? { path: note.position.new_path } : {}),
        ...(typeof note.position?.new_line === 'number' ? { line: note.position.new_line } : {})
      })
    }
  }
  // Why: oldest-first matches gitlab.com's conversation rendering and
  // makes "what's new" intuitive when polling for updates later.
  return out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
}

export async function fetchDiscussions(
  repoPath: string,
  projectRef: ProjectRef,
  type: 'issue' | 'mr',
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabRawDiscussion[]> {
  const resource = type === 'mr' ? 'merge_requests' : 'issues'
  const { stdout } = await glabExecFileAsync(
    [
      'api',
      ...glabHostnameArgs(projectRef, connectionId),
      // Why: detail drawers need a bounded recent conversation snapshot.
      // Walking every historic discussion can retain and render huge note sets.
      `projects/${encodedProject(projectRef.path)}/${resource}/${iid}/discussions?per_page=100`
    ],
    glabRepoExecOptions(repoPath, connectionId, localGitOptions)
  )
  return JSON.parse(stdout) as GitLabRawDiscussion[]
}
