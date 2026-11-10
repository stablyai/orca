import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { WorkspaceAttachment } from '../../shared/worktree/types'
import type { WorkspaceAttachmentMutation } from '../../shared/workspace-attachments/workspace-attachment-mutation'
import { getWorkspaceAttachments } from '../../shared/workspace-attachments/workspace-attachments'
import { WORKSPACE_ATTACHMENT_NUMBER_SLOTS } from '../../shared/workspace-attachments/workspace-attachment-legacy'
import { getWorkspaceReferenceIdentity } from '../../shared/workspace-attachments/workspace-reference-identity'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { WorktreeMetaWriteListener } from '../persistence/loading-store/write-scheduling'
import { findRepoRowForHostScopedWrite } from '../persistence/tracking-repos/repo-update-operations'

export type GitHubIssueLinkTitleFillStore = {
  onWorktreeMetaWritten: (listener: WorktreeMetaWriteListener) => () => void
  getWorktreeMetaForHost: (worktreeId: string, hostId: ExecutionHostId) => WorktreeMeta | undefined
  setWorktreeMeta: (
    target: HostWorktreeTarget,
    meta: Partial<WorktreeMeta> & WorkspaceAttachmentMutation
  ) => WorktreeMeta
  getRepos: () => Repo[]
}

type Job = {
  worktreeId: string
  hostId: ExecutionHostId
  instanceId: string | undefined
  identity: string
  link: WorkspaceAttachment
}

function untitledGitHubIssues(meta: WorktreeMeta | undefined): WorkspaceAttachment[] {
  return getWorkspaceAttachments(meta).filter(
    (item) => item.provider === 'github' && item.type === 'issue' && !item.title?.trim()
  )
}

/**
 * Links made without a title (CLI `--issue N`, phones, typed numbers) get the issue's title once, on the
 * host that owns the workspace, so search can match it without a client re-reading every linked issue.
 */
export function installGitHubIssueLinkTitleFill(deps: {
  store: GitHubIssueLinkTitleFillStore
  readIssueTitle: (repo: Repo, link: WorkspaceAttachment) => Promise<string | null>
  notifyChanged: (repoId: string) => void
  schedule?: (run: () => void) => void
}): () => void {
  const schedule = deps.schedule ?? ((run) => setImmediate(run))
  const queue = new Map<string, Job>()
  let draining = false
  let disposed = false

  const apply = (job: Job, title: string): void => {
    const meta = deps.store.getWorktreeMetaForHost(job.worktreeId, job.hostId)
    if (!meta || meta.instanceId !== job.instanceId) {
      return
    }
    const items = getWorkspaceAttachments(meta)
    const index = items.findIndex(
      (item) => getWorkspaceReferenceIdentity(item) === job.identity && !item.title?.trim()
    )
    if (index === -1) {
      return
    }
    // Restate the current review selection (null included) so the merge cannot re-pick one.
    const reviewSelection = Object.fromEntries(
      WORKSPACE_ATTACHMENT_NUMBER_SLOTS.filter(([, , type]) => type !== 'issue').map(([slot]) => [
        slot,
        meta[slot] ?? null
      ])
    )
    deps.store.setWorktreeMeta(hostWorktreeTarget({ id: job.worktreeId, hostId: job.hostId }), {
      ...reviewSelection,
      linkedItemsBase: items,
      linkedItems: items.map((item, i) => (i === index ? { ...item, title } : item))
    })
    deps.notifyChanged(getRepoIdFromWorktreeId(job.worktreeId))
  }

  const drain = async (): Promise<void> => {
    if (draining) {
      return
    }
    draining = true
    try {
      for (const [key, job] of queue) {
        queue.delete(key)
        if (disposed) {
          return
        }
        const repo = findRepoRowForHostScopedWrite(
          deps.store.getRepos(),
          getRepoIdFromWorktreeId(job.worktreeId),
          job.hostId
        )
        if (!repo) {
          continue
        }
        const title = await deps.readIssueTitle(repo, job.link).catch(() => null)
        if (title?.trim() && !disposed) {
          apply(job, title.trim())
        }
      }
    } finally {
      draining = false
    }
  }

  const unsubscribe = deps.store.onWorktreeMetaWritten(({ worktreeId, hostId, previous, next }) => {
    const known = new Set(
      previous?.instanceId === next.instanceId
        ? untitledGitHubIssues(previous).map(getWorkspaceReferenceIdentity)
        : []
    )
    let added = false
    for (const link of untitledGitHubIssues(next)) {
      const identity = getWorkspaceReferenceIdentity(link)
      if (known.has(identity)) {
        continue
      }
      queue.set(JSON.stringify([hostId, worktreeId, next.instanceId, identity]), {
        worktreeId,
        hostId,
        instanceId: next.instanceId,
        identity,
        link
      })
      added = true
    }
    if (added) {
      // Run after the caller's write returns; nothing the user asked for waits on GitHub.
      schedule(() => void drain())
    }
  })
  return () => {
    disposed = true
    queue.clear()
    unsubscribe()
  }
}
