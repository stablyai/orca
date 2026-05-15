import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Clipboard,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'

import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import {
  initLinearIssueEditState,
  LinearIssueCommentFooter,
  LinearIssueEditSection,
  type LinearEditState,
  type LinearLocalComment
} from '@/components/LinearItemDrawer'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import {
  buildLinearIssueBranchName,
  buildLinearIssuePrompt,
  formatLinearIssueRelativeTime
} from '@/components/linear-issue-workspace-text'
import { linearGetIssue, linearIssueComments } from '@/runtime/runtime-linear-client'
import type { LinearComment, LinearIssue } from '../../../shared/types'

type LinearIssueWorkspaceProps = {
  issue: LinearIssue | null
  onUse: (issue: LinearIssue) => void
  onClose: () => void
}

async function copyTextToClipboard(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(`${label} copied`)
  } catch {
    toast.error(`Failed to copy ${label.toLowerCase()}`)
  }
}

export default function LinearIssueWorkspace({
  issue,
  onUse,
  onClose
}: LinearIssueWorkspaceProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const [fullIssue, setFullIssue] = useState<LinearIssue | null>(null)
  const [issueLoading, setIssueLoading] = useState(false)
  const [comments, setComments] = useState<LinearComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [editState, setEditState] = useState<LinearEditState | null>(null)
  const requestIdRef = useRef(0)
  const hasEditedRef = useRef(false)
  const optimisticCommentsRef = useRef<LinearComment[]>([])

  const handleEditStateChange = useCallback((patch: Partial<LinearEditState>) => {
    hasEditedRef.current = true
    setEditState((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const loadComments = useCallback(
    async (targetIssue: LinearIssue, requestId: number): Promise<void> => {
      setCommentsLoading(true)
      setCommentsError(null)
      try {
        let fetched = (await linearIssueComments(
          settings,
          targetIssue.id,
          targetIssue.workspaceId
        )) as LinearComment[]
        if (requestId !== requestIdRef.current) {
          return
        }
        const optimistic = optimisticCommentsRef.current
        if (optimistic.length > 0) {
          const fetchedIds = new Set(fetched.map((comment) => comment.id))
          fetched = [...fetched, ...optimistic.filter((comment) => !fetchedIds.has(comment.id))]
        }
        setComments(fetched)
      } catch (error) {
        if (requestId === requestIdRef.current) {
          setCommentsError(error instanceof Error ? error.message : 'Failed to load comments.')
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setCommentsLoading(false)
        }
      }
    },
    [settings]
  )

  useEffect(() => {
    if (!issue) {
      setFullIssue(null)
      setIssueLoading(false)
      setComments([])
      setCommentsError(null)
      setEditState(null)
      hasEditedRef.current = false
      optimisticCommentsRef.current = []
      return
    }

    requestIdRef.current += 1
    const requestId = requestIdRef.current
    hasEditedRef.current = false
    optimisticCommentsRef.current = []
    setFullIssue(issue)
    setEditState(initLinearIssueEditState(issue))
    setComments([])
    setCommentsError(null)
    setIssueLoading(true)

    // Why: issue hydration and comments are separate surfaces; a comments
    // failure should not blank the issue detail the user selected.
    void linearGetIssue(settings, issue.id, issue.workspaceId)
      .then((issueResult) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (issueResult) {
          const fetched = issueResult as LinearIssue
          setFullIssue(fetched)
          if (!hasEditedRef.current) {
            setEditState(initLinearIssueEditState(fetched))
          }
        }
      })
      .catch(() => {
        /* The list issue remains useful if detail hydration is temporarily unavailable. */
      })
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setIssueLoading(false)
        }
      })

    void loadComments(issue, requestId)
  }, [issue, loadComments, settings])

  const displayed = fullIssue ?? issue

  const handleCommentAdded = useCallback((comment: LinearLocalComment) => {
    const newComment: LinearComment = {
      id: comment.id || createBrowserUuid(),
      body: comment.body,
      createdAt: comment.createdAt,
      user: { displayName: 'You' }
    }
    optimisticCommentsRef.current.push(newComment)
    setComments((prev) => [...prev, newComment])
  }, [])

  const actionItems = useMemo(() => {
    if (!displayed) {
      return []
    }
    return [
      {
        label: 'Open in Linear',
        icon: ExternalLink,
        action: () => window.api.shell.openUrl(displayed.url)
      },
      {
        label: 'Copy URL',
        icon: Clipboard,
        action: () => void copyTextToClipboard(displayed.url, 'URL')
      },
      {
        label: 'Copy identifier',
        icon: Clipboard,
        action: () => void copyTextToClipboard(displayed.identifier, 'Identifier')
      },
      {
        label: 'Copy suggested branch name',
        icon: GitBranch,
        action: () =>
          void copyTextToClipboard(buildLinearIssueBranchName(displayed), 'Suggested branch name')
      },
      {
        label: 'Copy prompt',
        icon: Clipboard,
        action: () => void copyTextToClipboard(buildLinearIssuePrompt(displayed), 'Prompt')
      }
    ]
  }, [displayed])

  return (
    <Sheet open={issue !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,760px)] p-0 sm:max-w-[760px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>{displayed?.title ?? 'Linear issue'}</SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            Preview, edit, and start work from the selected issue.
          </SheetDescription>
        </VisuallyHidden.Root>

        {displayed ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="font-mono">{displayed.identifier}</span>
                    {displayed.workspaceName ? <span>{displayed.workspaceName}</span> : null}
                    <span>{displayed.team.name}</span>
                    <span>{formatLinearIssueRelativeTime(displayed.updatedAt)}</span>
                    {issueLoading ? <LoaderCircle className="size-3 animate-spin" /> : null}
                  </div>
                  <h2 className="mt-1 text-[20px] font-semibold leading-tight text-foreground">
                    {displayed.title}
                  </h2>
                </div>
                <Button
                  onClick={() => onUse(displayed)}
                  className="hidden shrink-0 gap-2 sm:inline-flex"
                  size="sm"
                >
                  Start workspace
                  <ArrowRight className="size-4" />
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      onClick={onClose}
                      aria-label="Close Linear issue preview"
                    >
                      <X className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    Close
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            {editState ? (
              <LinearIssueEditSection
                issue={displayed}
                editState={editState}
                onEditStateChange={handleEditStateChange}
              />
            ) : null}

            <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_220px]">
              <div className="min-h-0 overflow-y-auto scrollbar-sleek">
                <section className="border-b border-border/40 px-4 py-4">
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ backgroundColor: displayed.state.color }}
                    />
                    <span className="text-xs font-medium text-foreground">
                      {displayed.state.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {displayed.assignee?.displayName ?? 'Unassigned'}
                    </span>
                  </div>
                  {displayed.description?.trim() ? (
                    <CommentMarkdown
                      content={displayed.description}
                      className="text-[14px] leading-relaxed"
                    />
                  ) : (
                    <p className="text-sm italic text-muted-foreground">No description provided.</p>
                  )}
                </section>

                <section className="px-4 py-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-foreground">Comments</span>
                      {comments.length > 0 ? (
                        <span className="text-[12px] text-muted-foreground">{comments.length}</span>
                      ) : null}
                    </div>
                    {commentsError ? (
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => void loadComments(displayed, requestIdRef.current)}
                        disabled={commentsLoading}
                        className="gap-1"
                      >
                        {commentsLoading ? (
                          <LoaderCircle className="size-3 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3" />
                        )}
                        Retry
                      </Button>
                    ) : null}
                  </div>

                  {commentsError ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {commentsError}
                    </div>
                  ) : commentsLoading && comments.length === 0 ? (
                    <div className="flex items-center justify-center py-8">
                      <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : comments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No comments yet.</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {comments.map((comment) => (
                        <div
                          key={comment.id}
                          className="rounded-md border border-border/50 bg-muted/20"
                        >
                          <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
                            {comment.user?.avatarUrl ? (
                              <img
                                src={comment.user.avatarUrl}
                                alt={comment.user.displayName}
                                className="size-5 shrink-0 rounded-full"
                              />
                            ) : null}
                            <span className="truncate text-[13px] font-semibold text-foreground">
                              {comment.user?.displayName ?? 'Unknown'}
                            </span>
                            <span className="shrink-0 text-[12px] text-muted-foreground">
                              {formatLinearIssueRelativeTime(comment.createdAt)}
                            </span>
                          </div>
                          <div className="px-3 py-2">
                            <CommentMarkdown
                              content={comment.body}
                              className="text-[13px] leading-relaxed"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              <aside className="border-t border-border/50 bg-muted/20 px-3 py-3 xl:border-l xl:border-t-0">
                <Button
                  onClick={() => onUse(displayed)}
                  className="mb-3 w-full justify-center gap-2 sm:hidden"
                >
                  Start workspace
                  <ArrowRight className="size-4" />
                </Button>
                <div className="grid gap-1">
                  {actionItems.map((item) => {
                    const Icon = item.icon
                    return (
                      <Tooltip key={item.label}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={item.action}
                            className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
                          >
                            <Icon className="size-3.5 shrink-0" />
                            <span className="truncate">{item.label}</span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="left" sideOffset={6}>
                          {item.label}
                        </TooltipContent>
                      </Tooltip>
                    )
                  })}
                </div>
              </aside>
            </div>

            <LinearIssueCommentFooter
              issueId={displayed.id}
              workspaceId={displayed.workspaceId}
              onCommentAdded={handleCommentAdded}
            />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
