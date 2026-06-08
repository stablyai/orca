/* eslint-disable max-lines -- Why: the Asana drawer co-locates preview,
   metadata edits, and comments so the task page has one full task surface. */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: Asana task hydration, comments, completion, and user options are loaded from provider IPC for the selected task. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Clipboard,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Save,
  Send,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'

import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { AsanaIcon } from '@/components/icons/AsanaIcon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import {
  asanaAddTaskComment,
  asanaGetTask,
  asanaListAssignableUsers,
  asanaTaskComments,
  asanaUpdateTask
} from '@/runtime/runtime-asana-client'
import type { AsanaComment, AsanaTask, AsanaUser } from '../../../shared/types'

type AsanaIssueWorkspaceProps = {
  task: AsanaTask | null
  onUse: (task: AsanaTask) => void
  onClose: () => void
}

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function formatRelativeTime(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return 'recently'
  }
  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60_000)
  if (Math.abs(diffMinutes) < 60) {
    return relativeFormatter.format(diffMinutes, 'minute')
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return relativeFormatter.format(diffHours, 'hour')
  }
  return relativeFormatter.format(Math.round(diffHours / 24), 'day')
}

// Why: Asana task gids are long numeric strings with no short human key, so the
// branch name leans on the title slug prefixed with a trailing gid fragment for
// uniqueness.
export function buildAsanaBranchName(task: AsanaTask): string {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
  const shortId = task.gid.slice(-6)
  return slug ? `asana-${shortId}-${slug}` : `asana-${shortId}`
}

function buildAsanaPrompt(task: AsanaTask): string {
  return `Complete Asana task: ${task.title}\n\n${task.url}`
}

async function copyTextToClipboard(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(`${label} copied`)
  } catch {
    toast.error(`Failed to copy ${label.toLowerCase()}`)
  }
}

export default function AsanaIssueWorkspace({
  task,
  onUse,
  onClose
}: AsanaIssueWorkspaceProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const patchAsanaTask = useAppStore((s) => s.patchAsanaTask)
  const [fullTask, setFullTask] = useState<AsanaTask | null>(null)
  const [taskLoading, setTaskLoading] = useState(false)
  const [comments, setComments] = useState<AsanaComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [users, setUsers] = useState<AsanaUser[]>([])
  const [pendingField, setPendingField] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const requestIdRef = useRef(0)
  const optimisticCommentsRef = useRef<AsanaComment[]>([])

  const displayed = fullTask ?? task
  const workspaceId = displayed?.workspaceId ?? undefined

  const loadComments = useCallback(
    async (targetTask: AsanaTask, requestId: number): Promise<void> => {
      setCommentsLoading(true)
      setCommentsError(null)
      try {
        let fetched = await asanaTaskComments(settings, targetTask.gid, targetTask.workspaceId)
        if (requestId !== requestIdRef.current) {
          return
        }
        const optimistic = optimisticCommentsRef.current
        if (optimistic.length > 0) {
          const fetchedIds = new Set(fetched.map((comment) => comment.gid))
          fetched = [...fetched, ...optimistic.filter((comment) => !fetchedIds.has(comment.gid))]
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
    if (!task) {
      setFullTask(null)
      setTaskLoading(false)
      setComments([])
      setCommentsError(null)
      setUsers([])
      setCommentDraft('')
      optimisticCommentsRef.current = []
      return
    }

    requestIdRef.current += 1
    const requestId = requestIdRef.current
    optimisticCommentsRef.current = []
    setFullTask(task)
    setTitleDraft(task.title)
    setNotesDraft(task.description ?? '')
    setComments([])
    setCommentsError(null)
    setTaskLoading(true)

    void asanaGetTask(settings, task.gid, task.workspaceId)
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (result) {
          setFullTask(result)
          setTitleDraft(result.title)
          setNotesDraft(result.description ?? '')
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setTaskLoading(false)
        }
      })

    void asanaListAssignableUsers(settings, task.workspaceId)
      .then((nextUsers) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setUsers(nextUsers)
      })
      .catch(() => {})

    void loadComments(task, requestId)
  }, [task, loadComments, settings])

  const refreshTask = useCallback(async (): Promise<void> => {
    if (!displayed) {
      return
    }
    try {
      const latest = await asanaGetTask(settings, displayed.gid, displayed.workspaceId)
      if (latest) {
        setFullTask(latest)
        patchAsanaTask(latest.gid, latest)
      }
    } catch {
      // Keep the visible task snapshot if refresh fails.
    }
  }, [displayed, patchAsanaTask, settings])

  const mutateTask = useCallback(
    async (
      field: string,
      updates: Parameters<typeof asanaUpdateTask>[2],
      optimistic?: Partial<AsanaTask>
    ): Promise<void> => {
      if (!displayed || pendingField) {
        return
      }
      setPendingField(field)
      const previous = displayed
      try {
        if (optimistic) {
          setFullTask({ ...displayed, ...optimistic })
          patchAsanaTask(displayed.gid, optimistic)
        }
        const result = await asanaUpdateTask(settings, displayed.gid, updates, workspaceId)
        if (!result.ok) {
          throw new Error(result.error)
        }
        await refreshTask()
      } catch (error) {
        setFullTask(previous)
        patchAsanaTask(previous.gid, previous)
        toast.error(error instanceof Error ? error.message : 'Failed to update Asana task.')
      } finally {
        setPendingField(null)
      }
    },
    [displayed, patchAsanaTask, pendingField, refreshTask, settings, workspaceId]
  )

  const handleSaveTitle = useCallback(() => {
    if (!displayed) {
      return
    }
    const title = titleDraft.trim()
    if (!title || title === displayed.title) {
      setTitleDraft(displayed.title)
      return
    }
    void mutateTask('title', { title }, { title })
  }, [displayed, mutateTask, titleDraft])

  const handleSaveNotes = useCallback(() => {
    if (!displayed) {
      return
    }
    const notes = notesDraft
    if (notes === (displayed.description ?? '')) {
      return
    }
    void mutateTask('notes', { notes }, { description: notes })
  }, [displayed, mutateTask, notesDraft])

  const handleToggleCompleted = useCallback(() => {
    if (!displayed) {
      return
    }
    const completed = !displayed.completed
    void mutateTask('completed', { completed }, { completed })
  }, [displayed, mutateTask])

  const handleSubmitComment = useCallback(async (): Promise<void> => {
    if (!displayed || commentSubmitting) {
      return
    }
    const text = commentDraft.trim()
    if (!text) {
      return
    }
    setCommentSubmitting(true)
    try {
      const result = await asanaAddTaskComment(settings, displayed.gid, text, displayed.workspaceId)
      if (!result.ok) {
        throw new Error(result.error)
      }
      const comment: AsanaComment = {
        gid: result.id || createBrowserUuid(),
        text,
        createdAt: new Date().toISOString(),
        user: { gid: 'local', name: 'You' }
      }
      optimisticCommentsRef.current.push(comment)
      setComments((prev) => [...prev, comment])
      setCommentDraft('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add comment.')
    } finally {
      setCommentSubmitting(false)
    }
  }, [commentDraft, commentSubmitting, displayed, settings])

  const actionItems = useMemo(() => {
    if (!displayed) {
      return []
    }
    return [
      {
        label: 'Open in Asana',
        icon: ExternalLink,
        action: () => window.api.shell.openUrl(displayed.url)
      },
      {
        label: 'Copy URL',
        icon: Clipboard,
        action: () => void copyTextToClipboard(displayed.url, 'URL')
      },
      {
        label: 'Copy suggested branch name',
        icon: GitBranch,
        action: () => void copyTextToClipboard(buildAsanaBranchName(displayed), 'Branch name')
      },
      {
        label: 'Copy prompt',
        icon: Clipboard,
        action: () => void copyTextToClipboard(buildAsanaPrompt(displayed), 'Prompt')
      }
    ]
  }, [displayed])

  const projectLabel = displayed?.projects[0]?.name ?? displayed?.workspaceName ?? 'Asana'

  return (
    <Sheet open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,780px)] p-0 sm:max-w-[780px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>{displayed?.title ?? 'Asana task'}</SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>Preview, edit, and start work from the selected task.</SheetDescription>
        </VisuallyHidden.Root>

        {displayed ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    {displayed.workspaceName ? <span>{displayed.workspaceName}</span> : null}
                    <span>{projectLabel}</span>
                    <span>{formatRelativeTime(displayed.updatedAt)}</span>
                    {taskLoading ? <LoaderCircle className="size-3 animate-spin" /> : null}
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
                      aria-label="Close Asana task preview"
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

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
              <button
                type="button"
                disabled={pendingField === 'completed'}
                onClick={handleToggleCompleted}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition hover:opacity-80 disabled:opacity-50',
                  displayed.completed
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
                    : 'border-border/50 bg-muted/40 text-muted-foreground'
                )}
              >
                {pendingField === 'completed' ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : displayed.completed ? (
                  <CheckCircle2 className="size-3" />
                ) : (
                  <Circle className="size-3" />
                )}
                {displayed.completed ? 'Completed' : 'Mark complete'}
              </button>

              {displayed.dueOn ? (
                <span className="text-[11px] text-muted-foreground">Due {displayed.dueOn}</span>
              ) : null}

              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={pendingField === 'assignee'}
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted/40 disabled:opacity-50"
                  >
                    {displayed.assignee?.name ?? '+ Assignee'}
                    {pendingField === 'assignee' ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : null}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="popover-scroll-content scrollbar-sleek w-56 p-1"
                  align="start"
                >
                  <button
                    type="button"
                    onClick={() =>
                      void mutateTask('assignee', { assigneeGid: null }, { assignee: undefined })
                    }
                    className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
                  >
                    Unassigned
                  </button>
                  {users.map((user) => (
                    <button
                      key={user.gid}
                      type="button"
                      onClick={() =>
                        void mutateTask('assignee', { assigneeGid: user.gid }, { assignee: user })
                      }
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
                    >
                      <span className="truncate">{user.name}</span>
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_228px]">
              <div className="min-h-0 overflow-y-auto scrollbar-sleek">
                <section className="border-b border-border/40 px-4 py-4">
                  <div className="grid gap-2">
                    <label className="text-[11px] font-medium text-muted-foreground">Title</label>
                    <div className="flex gap-2">
                      <Input
                        value={titleDraft}
                        onChange={(event) => setTitleDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                            event.preventDefault()
                            handleSaveTitle()
                          }
                        }}
                        className="h-8 text-xs"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleSaveTitle}
                        disabled={pendingField === 'title'}
                      >
                        {pendingField === 'title' ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Save className="size-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </section>

                <section className="border-b border-border/40 px-4 py-4">
                  <div className="mb-2 flex items-center gap-2">
                    <AsanaIcon className="size-3 text-muted-foreground" />
                    <span className="text-xs font-medium text-foreground">Description</span>
                    <span className="text-xs text-muted-foreground">
                      {projectLabel} · {displayed.assignee?.name ?? 'Unassigned'}
                    </span>
                  </div>
                  <div className="grid gap-2">
                    <textarea
                      value={notesDraft}
                      onChange={(event) => setNotesDraft(event.target.value)}
                      placeholder="No description provided."
                      rows={5}
                      className="min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleSaveNotes}
                        disabled={pendingField === 'notes'}
                        className="gap-2"
                      >
                        {pendingField === 'notes' ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Save className="size-4" />
                        )}
                        Save description
                      </Button>
                    </div>
                  </div>
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
                          key={comment.gid}
                          className="rounded-md border border-border/50 bg-muted/20"
                        >
                          <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
                            <span className="truncate text-[13px] font-semibold text-foreground">
                              {comment.user?.name ?? 'Unknown'}
                            </span>
                            <span className="shrink-0 text-[12px] text-muted-foreground">
                              {formatRelativeTime(comment.createdAt)}
                            </span>
                          </div>
                          <div className="px-3 py-2">
                            <CommentMarkdown
                              content={comment.text}
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

            <div className="flex-none border-t border-border/50 bg-background px-3 py-3">
              <div className="flex gap-2">
                <textarea
                  value={commentDraft}
                  onChange={(event) => setCommentDraft(event.target.value)}
                  placeholder="Add an Asana comment..."
                  rows={2}
                  disabled={commentSubmitting}
                  className="min-h-10 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
                <Button
                  onClick={() => void handleSubmitComment()}
                  disabled={!commentDraft.trim() || commentSubmitting}
                  className="self-end gap-2"
                >
                  {commentSubmitting ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  Comment
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
