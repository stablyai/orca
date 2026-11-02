import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { observeLinearIssueRead } from '@/store/slices/linear/linear-issue-publication'
import { useLinearIssuePublication } from '@/hooks/useLinearIssuePublication'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { findLinearIssueWorkspaceAttachment } from '@/lib/linear-issue-workspace-attachment'
import { openLinearIssueWorkspaceOrStart } from '@/lib/linear-issue-workspace-open'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useAllWorktrees } from '@/store/selectors'
import type { LinearComment } from '../../../shared/linear/issue-types'
import { linearIssueComments } from '@/runtime/runtime-linear-issue-mutations'
import {
  initLinearIssueEditState,
  type LinearItemDrawerProps,
  type LinearLocalComment
} from '@/components/linear-item-drawer-types'
import { renderLinearItemDrawerSheet } from '@/components/linear-item-drawer-sheet'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { defaultScopeSource } from '@/lib/default-creation-host'

export { LinearIssueEditSection } from '@/components/linear-item-drawer-edit-section'
export { LinearIssueCommentFooter } from '@/components/linear-item-drawer-comment-footer'
export { formatLinearEstimateLabel } from '@/components/linear-item-drawer-edit-controls'
export { initLinearIssueEditState } from '@/components/linear-item-drawer-types'
export type { LinearEditState, LinearLocalComment } from '@/components/linear-item-drawer-types'

export default function LinearItemDrawer({
  issue,
  onUse,
  onClose,
  sourceContext
}: LinearItemDrawerProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? defaultScopeSource(settings)
  const scope = getLinearSourceScope(providerSettings)
  const publication = useLinearIssuePublication(issue, providerSettings)
  const { isCurrent } = publication
  const fullIssue = publication.issue
  const [comments, setComments] = useState<LinearComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const editState = fullIssue ? initLinearIssueEditState(fullIssue) : null
  const requestIdRef = useRef(0)
  const optimisticCommentsRef = useRef<LinearComment[]>([])
  const allWorktrees = useAllWorktrees()
  const folderWorkspaces = useAppStore((s) => selectFolderWorkspaces(s))
  const attachmentWorkspaces = useMemo(
    () => [...allWorktrees, ...folderWorkspaces.map(folderWorkspaceToWorktree)],
    [allWorktrees, folderWorkspaces]
  )

  // List rows may omit descriptions; fetch full issue and comments for the drawer.
  // oxlint-disable-next-line react-doctor/no-derived-state-effect -- Why: resets drafts as it starts the fenced IPC fetch for a new issue id.
  useEffect(() => {
    if (!issue) {
      setComments([])
      return
    }
    optimisticCommentsRef.current = []
    setComments([])
    setCommentsLoading(true)

    requestIdRef.current += 1
    const requestId = requestIdRef.current

    // Fetch independently so comments failure cannot discard the issue.
    let initial = true
    const release = observeLinearIssueRead(
      useAppStore.getState().fetchLinearIssue(issue.id, issue.workspaceId, {
        scope,
        force: true,
        seed: issue
      }),
      () => requestId === requestIdRef.current && isCurrent(),
      (lease, view) => {
        const seed = initial && view.kind === 'loading'
        initial = false
        publication.read(lease, view, seed)
      }
    )

    linearIssueComments(providerSettings, issue.id, issue.workspaceId)
      .then((commentsResult) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        // Merge optimistic comments posted during fetch, deduplicating by id.
        let fetched = commentsResult as LinearComment[]
        const opt = optimisticCommentsRef.current
        if (opt.length > 0) {
          const fetchedIds = new Set(fetched.map((c) => c.id))
          const missing = opt.filter((c) => !fetchedIds.has(c.id))
          if (missing.length > 0) {
            fetched = [...fetched, ...missing]
          }
        }
        setComments((previous) =>
          // react-doctor-disable-next-line react-doctor/no-impure-state-updater -- Read-only lifetime predicate must run at consumption; it mutates no state or token.
          requestId === requestIdRef.current && isCurrent() ? fetched : previous
        )
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setCommentsLoading((previous) =>
            // react-doctor-disable-next-line react-doctor/no-impure-state-updater -- Read-only lifetime predicate must run at consumption; it mutates no state or token.
            requestId === requestIdRef.current && isCurrent() ? false : previous
          )
        }
      })
    return () => {
      requestIdRef.current += 1
      release()
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, issue?.workspaceId, scope.contextKey, publication.read])

  // Clear Radix’s stale body pointer-events after overlay transitions, as GitHubItemDialog does.
  useEffect(() => {
    if (!issue?.id) {
      return
    }
    let cancelled = false
    let count = 0
    let frameId: number | null = null
    const tick = (): void => {
      frameId = null
      if (cancelled) {
        return
      }
      if (document.body.style.pointerEvents === 'none') {
        document.body.style.pointerEvents = ''
      }
      if (count++ < 5) {
        frameId = requestAnimationFrame(tick)
      }
    }
    tick()
    return () => {
      cancelled = true
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
    }
  }, [issue?.id])

  const handleCommentAdded = useCallback((comment: LinearLocalComment) => {
    const newComment: LinearComment = {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      user: { displayName: translate('auto.components.issueComments.you', 'You') }
    }
    optimisticCommentsRef.current.push(newComment)
    setComments((prev) => [...prev, newComment])
  }, [])

  const displayed = fullIssue ?? issue
  const attachedWorkspace = useMemo(
    () => (displayed ? findLinearIssueWorkspaceAttachment(attachmentWorkspaces, displayed) : null),
    [attachmentWorkspaces, displayed]
  )
  const attachedWorkspaceLabel = attachedWorkspace
    ? getWorktreeAttachmentLabel(attachedWorkspace)
    : null

  const handleOpenOrUseIssue = useCallback((): void => {
    if (!displayed) {
      return
    }
    openLinearIssueWorkspaceOrStart(displayed, () => onUse(displayed))
  }, [displayed, onUse])

  return renderLinearItemDrawerSheet({
    issue,
    onClose,
    displayed,
    sourceContext,
    editState,
    commentsLoading,
    comments,
    handleCommentAdded,
    attachedWorkspaceLabel,
    attachedWorkspace,
    handleOpenOrUseIssue,
    onUse
  })
}
