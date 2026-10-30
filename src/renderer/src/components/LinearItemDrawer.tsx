import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { findLinearIssueWorkspaceAttachment } from '@/lib/linear-issue-workspace-attachment'
import { openLinearIssueWorkspaceOrStart } from '@/lib/linear-issue-workspace-open'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useAllWorktrees } from '@/store/selectors'
import type { LinearComment, LinearIssue } from '../../../shared/linear/issue-types'
import { linearGetIssue, linearIssueComments } from '@/runtime/runtime-linear-issue-mutations'
import {
  initLinearIssueEditState,
  type LinearEditState,
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
  const [fullIssue, setFullIssue] = useState<LinearIssue | null>(null)
  const [comments, setComments] = useState<LinearComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [editState, setEditState] = useState<LinearEditState | null>(null)
  const requestIdRef = useRef(0)
  const hasEditedRef = useRef(false)
  const optimisticCommentsRef = useRef<LinearComment[]>([])
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? defaultScopeSource(settings)
  const allWorktrees = useAllWorktrees()
  const folderWorkspaces = useAppStore((s) => selectFolderWorkspaces(s))
  const attachmentWorkspaces = useMemo(
    () => [...allWorktrees, ...folderWorkspaces.map(folderWorkspaceToWorktree)],
    [allWorktrees, folderWorkspaces]
  )

  const handleEditStateChange = useCallback((patch: Partial<LinearEditState>) => {
    hasEditedRef.current = true
    setFullIssue((prev) => (prev ? { ...prev, ...patch } : prev))
    setEditState((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const handleIssueTextChange = useCallback(
    (patch: Partial<Pick<LinearIssue, 'title' | 'description'>>) => {
      hasEditedRef.current = true
      setFullIssue((prev) => (prev ? { ...prev, ...patch } : prev))
    },
    []
  )

  // List rows may omit descriptions; fetch full issue and comments for the drawer.
  // oxlint-disable-next-line react-doctor/no-derived-state-effect -- Why: resets drafts as it starts the fenced IPC fetch for a new issue id.
  useEffect(() => {
    if (!issue) {
      setFullIssue(null)
      setComments([])
      setEditState(null)
      hasEditedRef.current = false
      return
    }
    hasEditedRef.current = false
    optimisticCommentsRef.current = []
    setComments([])
    setCommentsLoading(true)
    setEditState(initLinearIssueEditState(issue))
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    setFullIssue(issue)

    // Fetch independently so comments failure cannot discard the issue.
    linearGetIssue(providerSettings, issue.id, issue.workspaceId)
      .then((issueResult) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (issueResult) {
          const fetched = issueResult as LinearIssue
          setFullIssue(fetched)
          // Preserve optimistic edits made after the fetch began.
          if (!hasEditedRef.current) {
            setEditState(initLinearIssueEditState(fetched))
          }
        }
      })
      .catch(() => {})

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
        setComments(fetched)
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setCommentsLoading(false)
        }
      })
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, issue?.workspaceId, providerSettings])

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
    handleIssueTextChange,
    sourceContext,
    editState,
    handleEditStateChange,
    commentsLoading,
    comments,
    handleCommentAdded,
    attachedWorkspaceLabel,
    attachedWorkspace,
    handleOpenOrUseIssue,
    onUse
  })
}
