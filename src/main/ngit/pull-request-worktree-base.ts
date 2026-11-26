import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import type { NgitWorktreeBaseResult } from '../../shared/ngit/ngit-work-item-types'
import type { ProjectedWorkItem } from './work-item-projection'

const OBJECT_ID = /^[0-9a-f]{40,64}$/

/** A workspace name whose branch Orca can trace back to the pull request. */
export function ngitPullRequestWorkspaceName({ item }: ProjectedWorkItem): string {
  const name = (item.branchName ?? item.title)
    .replace(/^pr\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `${name || 'pr'}-${item.eventId.slice(0, 8)}`
}

/** Fetches a pull request's tip so a worktree can start from it. */
export async function fetchNgitPullRequestBase(
  repoPath: string,
  pull: ProjectedWorkItem,
  localGitOptions: { wslDistro?: string } = {}
): Promise<NgitWorktreeBaseResult> {
  const { headSha, eventId, isPatch } = pull.item
  if (isPatch) {
    return {
      ok: false,
      error: `This is a patch series. Create a workspace, then run \`ngit pr checkout ${eventId}\`.`
    }
  }
  if (!headSha || !OBJECT_ID.test(headSha)) {
    return { ok: false, error: 'This pull request does not name a commit.' }
  }
  const git = (args: string[]) => gitExecFileAsync(args, { cwd: repoPath, ...localGitOptions })
  const hasCommit = (): Promise<boolean> =>
    git(['cat-file', '-e', `${headSha}^{commit}`]).then(
      () => true,
      () => false
    )
  // The URLs are published by strangers: only network git transports, never local or helper ones.
  for (const url of pull.cloneUrls.filter((value) => /^https?:\/\//i.test(value))) {
    if (await hasCommit()) {
      break
    }
    // GRASP servers expose each pull request under refs/nostr/<event id>.
    await git(['fetch', '--no-tags', '--', url, `refs/nostr/${eventId}`]).catch(() =>
      git(['fetch', '--no-tags', '--', url, headSha]).catch(() => undefined)
    )
  }
  return (await hasCommit())
    ? { ok: true, baseBranch: headSha, workspaceName: ngitPullRequestWorkspaceName(pull) }
    : { ok: false, error: 'Could not fetch this pull request from its git servers.' }
}
