import type { Repo } from '../../shared/repository/repo-types'
import { getRepoRoutingConnectionId } from '../../shared/execution-host/execution-host'
import type {
  NgitMutationResult,
  NgitStatusAction,
  NgitWorkItem,
  NgitWorkItemDetails,
  NgitWorkItemList,
  NgitWorktreeBaseResult
} from '../../shared/ngit/ngit-work-item-types'
import { formatNostrCloneUrl } from './nostr-repository-address'
import { getNostrRepoRef } from './repository-ref'
import { forgetNostrRepositorySnapshots, getNostrRepositorySnapshot } from './repository-snapshot'
import { projectNostrComment, type ProjectedWorkItem } from './work-item-projection'
import {
  addNgitComment,
  createNgitIssue,
  setNgitWorkItemStatus,
  type NgitWriteTarget
} from './work-item-mutations'
import { fetchNgitPullRequestBase } from './pull-request-worktree-base'

type LocalGitExecOptions = { wslDistro?: string }

async function readSnapshot(repo: Repo, localGit: LocalGitExecOptions, force: boolean) {
  // A folder workspace has no remotes to name a nostr repository.
  if (repo.kind === 'folder') {
    return null
  }
  const ref = await getNostrRepoRef(repo.path, getRepoRoutingConnectionId(repo), localGit)
  return ref ? getNostrRepositorySnapshot(ref, { force }) : null
}

function workItem(repo: Repo, { item }: ProjectedWorkItem): NgitWorkItem {
  return { ...item, id: `ngit-${item.type}-${repo.id}-${item.eventId}`, repoId: repo.id }
}

export async function listNgitWorkItems(
  repo: Repo,
  localGit: LocalGitExecOptions,
  { force = false }: { force?: boolean } = {}
): Promise<NgitWorkItemList> {
  const snapshot = await readSnapshot(repo, localGit, force)
  if (!snapshot) {
    return { repository: null, items: [] }
  }
  const { identifier, name, webUrl } = snapshot.repository
  return {
    repository: { identifier, name, webUrl },
    items: snapshot.items.map((projected) => workItem(repo, projected))
  }
}

export async function getNgitWorkItemDetails(
  repo: Repo,
  localGit: LocalGitExecOptions,
  eventId: string,
  { force = false }: { force?: boolean } = {}
): Promise<NgitWorkItemDetails | null> {
  const snapshot = await readSnapshot(repo, localGit, force)
  const projected = snapshot?.items.find(({ item }) => item.eventId === eventId)
  if (!projected) {
    return null
  }
  const commentProfiles = projected.commentProfiles
  return {
    item: workItem(repo, projected),
    body: projected.body,
    comments: projected.comments.map((event) =>
      projectNostrComment(event, eventId, commentProfiles)
    ),
    patches: projected.patches,
    cloneUrls: projected.cloneUrls
  }
}

/** Writes need a repository to run `ngit` in and a published repository to address. */
async function write(
  repo: Repo,
  localGit: LocalGitExecOptions,
  publish: (target: NgitWriteTarget) => Promise<NgitMutationResult>
): Promise<NgitMutationResult> {
  if (getRepoRoutingConnectionId(repo)) {
    return { ok: false, error: 'Publishing to ngit is not available for SSH repositories yet.' }
  }
  const snapshot = await readSnapshot(repo, localGit, false)
  if (!snapshot) {
    return { ok: false, error: 'This is not an ngit repository.' }
  }
  const { ownerPubkey, identifier, relays } = snapshot.repository
  const result = await publish({
    cwd: repo.path,
    repo: formatNostrCloneUrl(ownerPubkey, identifier, relays[0])
  })
  forgetNostrRepositorySnapshots()
  return result
}

export const createNgitRepoIssue = (
  repo: Repo,
  localGit: LocalGitExecOptions,
  title: string,
  body: string
) => write(repo, localGit, (target) => createNgitIssue(target, title, body))

export const addNgitRepoComment = (
  repo: Repo,
  localGit: LocalGitExecOptions,
  type: NgitWorkItem['type'],
  eventId: string,
  body: string
) => write(repo, localGit, (target) => addNgitComment(target, type, eventId, body))

export const setNgitRepoWorkItemStatus = (
  repo: Repo,
  localGit: LocalGitExecOptions,
  type: NgitWorkItem['type'],
  eventId: string,
  action: NgitStatusAction
) => write(repo, localGit, (target) => setNgitWorkItemStatus(target, type, eventId, action))

export async function resolveNgitPullRequestBase(
  repo: Repo,
  localGit: LocalGitExecOptions,
  eventId: string
): Promise<NgitWorktreeBaseResult> {
  if (getRepoRoutingConnectionId(repo)) {
    return { ok: false, error: 'Starting from an ngit pull request needs a local repository.' }
  }
  const snapshot = await readSnapshot(repo, localGit, false)
  const pull = snapshot?.items.find(({ item }) => item.eventId === eventId && item.type === 'pr')
  return pull
    ? fetchNgitPullRequestBase(repo.path, pull, localGit)
    : { ok: false, error: 'That pull request is no longer on the relays.' }
}
