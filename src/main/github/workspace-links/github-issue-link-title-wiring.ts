import type { Repo } from '../../../shared/repo-types'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  workspaceMetadataSetRow,
  type WorkspaceMetadataSet
} from '../../../shared/worktree/workspace-metadata-set'
import type { WorkspaceAttachment } from '../../../shared/worktree/types'
import { getRepoRoutingConnectionId } from '../../../shared/execution-host'
import type { Store } from '../../persistence/loading-store/store'
import { getLocalProjectGhExecOptions } from '../../workspaces/execution-host/project-runtime-git-options'
import { getIssue } from '../issues/issues'
import { getWorkItemByOwnerRepo } from '../client/fetch/get-work-item'
import { installGitHubIssueLinkTitleFill } from './github-issue-link-title-fill'
import { readGitHubRepoUnlessWslStopped } from '../../ipc/source-control/github-repo-routing'

const GITHUB_ISSUE_PATH = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)$/

function sameIssueUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left)
    const b = new URL(right)
    return (
      a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
      a.pathname.replace(/\/+$/, '').toLowerCase() === b.pathname.replace(/\/+$/, '').toLowerCase()
    )
  } catch {
    return false
  }
}

/** Reads a link's issue the way its display does: a URL names its repo; a bare number uses the card's lookup. */
async function readGitHubIssueLinkTitle(
  store: Store,
  repo: Repo,
  link: WorkspaceAttachment
): Promise<string | null> {
  const connectionId = getRepoRoutingConnectionId(repo)
  const options = getLocalProjectGhExecOptions(store, repo)
  if (link.url) {
    const url = new URL(link.url)
    const route = GITHUB_ISSUE_PATH.exec(url.pathname)
    if (!route || Number(route[3]) !== link.number) {
      return null
    }
    const item = await getWorkItemByOwnerRepo(
      repo.path,
      { owner: route[1], repo: route[2], host: url.hostname },
      link.number,
      'issue',
      connectionId,
      options,
      { preview: true }
    )
    return item?.type === 'issue' && item.number === link.number && sameIssueUrl(item.url, link.url)
      ? item.title
      : null
  }
  const issue = await getIssue(repo.path, link.number, connectionId, options)
  // The issues endpoint also answers PR numbers; a PR's title must not label an issue link.
  return issue && issue.number === link.number && !/\/pull\/\d+$/.test(issue.url)
    ? issue.title
    : null
}

export function wireGitHubIssueLinkTitleFill(
  store: Store,
  runtime: {
    invalidateResolvedWorktreeCache: () => void
    publishWorkspaceMetadataSet: (set: WorkspaceMetadataSet) => void
  }
): () => void {
  return installGitHubIssueLinkTitleFill({
    store,
    // Background reads never start a stopped WSL distro; the link just stays untitled.
    readIssueTitle: (repo, link) =>
      readGitHubRepoUnlessWslStopped(
        store,
        repo,
        () => readGitHubIssueLinkTitle(store, repo, link),
        {
          wake: false
        }
      ),
    publish: ({ worktreeId, hostId, meta }) => {
      // Resolved rows embed metadata; refresh them so the next listing read agrees.
      runtime.invalidateResolvedWorktreeCache()
      // Same turn as the title write, so a listing either read it or carries an older seq.
      const { epoch, seq } = store.advanceWorkspaceMetadataCursor()
      runtime.publishWorkspaceMetadataSet({
        kind: 'set',
        domain: 'workspaceMetadata',
        hostId,
        epoch,
        seq,
        id: composeWorktreeHostIdentity(hostId, worktreeId),
        repoId: getRepoIdFromWorktreeId(worktreeId),
        worktreeId,
        row: workspaceMetadataSetRow(meta)
      })
    }
  })
}
