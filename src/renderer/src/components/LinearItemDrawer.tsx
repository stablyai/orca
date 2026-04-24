/* eslint-disable max-lines -- Why: the Linear drawer co-locates read-only preview, edit controls, and comment input so the full issue surface stays in one file. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, ExternalLink, LoaderCircle, Send, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { VisuallyHidden } from 'radix-ui'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import {
  useTeamStates,
  useTeamLabels,
  useTeamMembers,
  useImmediateMutation
} from '@/hooks/useIssueMetadata'
import type { LinearIssue, LinearComment } from '../../../shared/types'

function LinearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

const PRIORITY_LABELS: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
}

function formatRelativeTime(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return 'recently'
  }
  const diffMs = date.getTime() - Date.now()
  const diffMinutes = Math.round(diffMs / 60_000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, 'minute')
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, 'hour')
  }
  const diffDays = Math.round(diffHours / 24)
  return formatter.format(diffDays, 'day')
}

// Why: derive pill border/background/text from the actual Linear state color
// so the pill always matches the colored dot, regardless of state type.
function statePillStyle(color: string): React.CSSProperties {
  return {
    borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
    color
  }
}

type LinearItemDrawerProps = {
  issue: LinearIssue | null
  onUse: (issue: LinearIssue) => void
  onClose: () => void
}

type LinearEditState = {
  state: LinearIssue['state']
  priority: number
  assignee: LinearIssue['assignee']
  labelIds: string[]
  labels: string[]
}

type EditSectionProps = {
  issue: LinearIssue
  editState: LinearEditState
  onEditStateChange: (patch: Partial<LinearEditState>) => void
}

function EditSection({ issue, editState, onEditStateChange }: EditSectionProps): React.JSX.Element {
  const [labelPopoverOpen, setLabelPopoverOpen] = useState(false)
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const { isPending, run } = useImmediateMutation()

  const {
    state: localState,
    priority: localPriority,
    assignee: localAssignee,
    labelIds: localLabelIds,
    labels: localLabels
  } = editState

  const teamId = issue.team?.id || null
  const states = useTeamStates(teamId)
  const labels = useTeamLabels(teamId)
  const members = useTeamMembers(teamId)

  const handleStateChange = useCallback(
    (stateId: string) => {
      const newState = states.data.find((s) => s.id === stateId)
      if (!newState) {
        return
      }

      const prevState = localState
      const stateValue = { name: newState.name, type: newState.type, color: newState.color }

      run('state', {
        mutate: () => window.api.linear.updateIssue({ id: issue.id, updates: { stateId } }),
        onOptimistic: () => {
          onEditStateChange({ state: stateValue })
          patchLinearIssue(issue.id, { state: stateValue })
        },
        onRevert: () => {
          onEditStateChange({ state: prevState })
          patchLinearIssue(issue.id, { state: prevState })
        },
        onError: (err) => toast.error(err)
      })
    },
    [issue.id, localState, states.data, patchLinearIssue, run, onEditStateChange]
  )

  const handlePriorityChange = useCallback(
    (value: string) => {
      const priority = parseInt(value, 10)
      const prevPriority = localPriority
      run('priority', {
        mutate: () => window.api.linear.updateIssue({ id: issue.id, updates: { priority } }),
        onOptimistic: () => {
          onEditStateChange({ priority })
          patchLinearIssue(issue.id, { priority })
        },
        onRevert: () => {
          onEditStateChange({ priority: prevPriority })
          patchLinearIssue(issue.id, { priority: prevPriority })
        },
        onError: (err) => toast.error(err)
      })
    },
    [issue.id, localPriority, patchLinearIssue, run, onEditStateChange]
  )

  const handleAssigneeChange = useCallback(
    (memberId: string) => {
      const assigneeId = memberId === '__unassign__' ? null : memberId
      const member = members.data.find((m) => m.id === memberId)
      const prevAssignee = localAssignee
      const newAssignee = member
        ? { id: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl }
        : undefined
      run('assignee', {
        mutate: () => window.api.linear.updateIssue({ id: issue.id, updates: { assigneeId } }),
        onOptimistic: () => {
          onEditStateChange({ assignee: newAssignee })
          patchLinearIssue(issue.id, { assignee: newAssignee })
        },
        onRevert: () => {
          onEditStateChange({ assignee: prevAssignee })
          patchLinearIssue(issue.id, { assignee: prevAssignee })
        },
        onError: (err) => toast.error(err)
      })
    },
    [issue.id, localAssignee, members.data, patchLinearIssue, run, onEditStateChange]
  )

  const handleLabelToggle = useCallback(
    (labelId: string) => {
      const prevLabelIds = localLabelIds
      const prevLabels = localLabels
      const isRemoving = prevLabelIds.includes(labelId)
      const newLabelIds = isRemoving
        ? prevLabelIds.filter((id) => id !== labelId)
        : [...prevLabelIds, labelId]
      const newLabels = newLabelIds
        .map((id) => labels.data.find((l) => l.id === id)?.name)
        .filter((n): n is string => !!n)

      run('labels', {
        mutate: () =>
          window.api.linear.updateIssue({ id: issue.id, updates: { labelIds: newLabelIds } }),
        onOptimistic: () => {
          onEditStateChange({ labelIds: newLabelIds, labels: newLabels })
          patchLinearIssue(issue.id, { labelIds: newLabelIds, labels: newLabels })
        },
        onRevert: () => {
          onEditStateChange({ labelIds: prevLabelIds, labels: prevLabels })
          patchLinearIssue(issue.id, { labelIds: prevLabelIds, labels: prevLabels })
        },
        onError: (err) => toast.error(err)
      })
    },
    [issue.id, localLabelIds, localLabels, labels.data, patchLinearIssue, run, onEditStateChange]
  )

  const currentStateId = states.data.find(
    (s) => s.name === localState.name && s.type === localState.type
  )?.id

  const checkIcon = (
    <svg className="size-2.5" viewBox="0 0 12 12" fill="none">
      <path
        d="M2 6l3 3 5-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
      {/* Status */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isPending('state') || states.loading}
            className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition hover:opacity-80 disabled:opacity-50"
            style={statePillStyle(localState.color)}
          >
            <span
              className="inline-block size-2 rounded-full"
              style={{ backgroundColor: localState.color }}
            />
            {localState.name}
            {isPending('state') && <LoaderCircle className="size-3 animate-spin" />}
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-48 p-1" align="start">
          <div>
            {states.data.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => handleStateChange(s.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
                  currentStateId === s.id && 'bg-accent/50'
                )}
              >
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                {s.name}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Priority */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isPending('priority')}
            className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted/40 disabled:opacity-50"
          >
            {PRIORITY_LABELS[localPriority] ?? `P${localPriority}`}
            {isPending('priority') && <LoaderCircle className="ml-1 inline size-3 animate-spin" />}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-36 p-1" align="start">
          {[0, 1, 2, 3, 4].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => handlePriorityChange(String(p))}
              className={cn(
                'flex w-full items-center rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
                localPriority === p && 'bg-accent/50'
              )}
            >
              {PRIORITY_LABELS[p]}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Assignee */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isPending('assignee') || members.loading}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition hover:bg-muted/40 disabled:opacity-50"
          >
            {localAssignee ? (
              <span className="text-muted-foreground">{localAssignee.displayName}</span>
            ) : (
              <span className="text-muted-foreground">+ Assignee</span>
            )}
            {isPending('assignee') && (
              <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-48 p-1" align="start">
          <div>
            <button
              type="button"
              onClick={() => handleAssigneeChange('__unassign__')}
              className={cn(
                'flex w-full items-center rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
                !localAssignee && 'bg-accent/50'
              )}
            >
              Unassigned
            </button>
            {members.data.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => handleAssigneeChange(m.id)}
                className={cn(
                  'flex w-full items-center rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
                  localAssignee?.id === m.id && 'bg-accent/50'
                )}
              >
                {m.displayName}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Labels */}
      <Popover open={labelPopoverOpen} onOpenChange={setLabelPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isPending('labels') || labels.loading}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition hover:bg-muted/40 disabled:opacity-50"
          >
            {localLabelIds.length === 0 ? (
              <span className="text-muted-foreground">+ Label</span>
            ) : (
              localLabels.map((name) => (
                <span
                  key={name}
                  className="rounded-full border border-border/50 bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {name}
                </span>
              ))
            )}
            {isPending('labels') && (
              <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-52 p-1" align="start">
          {labels.error ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">{labels.error}</div>
          ) : (
            <div>
              {labels.data.map((label) => (
                <button
                  key={label.id}
                  type="button"
                  onClick={() => handleLabelToggle(label.id)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent"
                >
                  <span
                    className={cn(
                      'flex size-3.5 items-center justify-center rounded-sm border',
                      localLabelIds.includes(label.id)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input'
                    )}
                  >
                    {localLabelIds.includes(label.id) && checkIcon}
                  </span>
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  {label.name}
                </button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

type LocalComment = { id: string; body: string; createdAt: string }

function CommentFooter({
  issueId,
  onCommentAdded
}: {
  issueId: string
  onCommentAdded: (comment: LocalComment) => void
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const autoGrow = useCallback(() => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`
  }, [])

  const handleSubmit = useCallback(async () => {
    const trimmed = body.trim()
    if (!trimmed) {
      return
    }
    setSubmitting(true)
    try {
      const result = await window.api.linear.addIssueComment({ issueId, body: trimmed })
      const typed = result as { ok: boolean; id?: string; error?: string }
      if (typed.ok) {
        setBody('')
        onCommentAdded({
          id: typed.id ?? crypto.randomUUID(),
          body: trimmed,
          createdAt: new Date().toISOString()
        })
      } else {
        toast.error(typed.error ?? 'Failed to add comment')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add comment')
    } finally {
      setSubmitting(false)
    }
  }, [body, issueId, onCommentAdded])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  return (
    <div className="flex items-end gap-2 border-t border-border/60 bg-background/40 px-4 py-3">
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          autoGrow()
        }}
        onKeyDown={handleKeyDown}
        placeholder="Add a comment…"
        rows={1}
        className="scrollbar-sleek min-h-[32px] max-h-[96px] flex-1 resize-none overflow-y-auto rounded-md border border-input bg-transparent px-3 py-2 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <Button
        size="icon"
        onClick={handleSubmit}
        disabled={!body.trim() || submitting}
        className="size-8 shrink-0"
        aria-label="Send comment"
      >
        {submitting ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Send className="size-3.5" />
        )}
      </Button>
    </div>
  )
}

function initEditState(issue: LinearIssue): LinearEditState {
  return {
    state: issue.state,
    priority: issue.priority,
    assignee: issue.assignee,
    labelIds: issue.labelIds,
    labels: issue.labels
  }
}

export default function LinearItemDrawer({
  issue,
  onUse,
  onClose
}: LinearItemDrawerProps): React.JSX.Element {
  const [fullIssue, setFullIssue] = useState<LinearIssue | null>(null)
  const [comments, setComments] = useState<LinearComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [editState, setEditState] = useState<LinearEditState | null>(null)
  const requestIdRef = useRef(0)
  const hasEditedRef = useRef(false)
  const optimisticCommentsRef = useRef<LinearComment[]>([])

  const handleEditStateChange = useCallback((patch: Partial<LinearEditState>) => {
    hasEditedRef.current = true
    setEditState((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  // Why: the list view may not include the full description. Re-fetch
  // the issue by ID and its comments to populate the drawer.
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
    setEditState(initEditState(issue))
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    setFullIssue(issue)

    // Why: fetch issue and comments independently so a transient comments
    // failure doesn't discard the successfully-fetched issue data.
    window.api.linear
      .getIssue({ id: issue.id })
      .then((issueResult) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (issueResult) {
          const fetched = issueResult as LinearIssue
          setFullIssue(fetched)
          // Why: skip if the user already made optimistic edits — the fetch
          // carries pre-edit data that would clobber in-flight changes.
          if (!hasEditedRef.current) {
            setEditState(initEditState(fetched))
          }
        }
      })
      .catch(() => {})

    window.api.linear
      .issueComments({ issueId: issue.id })
      .then((commentsResult) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        // Why: merge any comments the user posted optimistically while the
        // fetch was in-flight, using id to avoid duplicates.
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
  }, [issue?.id])

  // Why: same pointer-events fix as GitHubItemDrawer — Radix may leave
  // pointer-events: none on body when overlays transition.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!issue?.id) {
      return
    }
    let cancelled = false
    let count = 0
    const tick = (): void => {
      if (cancelled) {
        return
      }
      if (document.body.style.pointerEvents === 'none') {
        document.body.style.pointerEvents = ''
      }
      if (count++ < 5) {
        requestAnimationFrame(tick)
      }
    }
    tick()
    return () => {
      cancelled = true
    }
  }, [issue?.id])

  const handleCommentAdded = useCallback((comment: LocalComment) => {
    const newComment: LinearComment = {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      user: { displayName: 'You' }
    }
    optimisticCommentsRef.current.push(newComment)
    setComments((prev) => [...prev, newComment])
  }, [])

  const displayed = fullIssue ?? issue

  return (
    <Sheet open={issue !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full p-0 sm:max-w-[640px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>{displayed?.title ?? 'Linear issue'}</SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>Preview and edit the selected Linear issue.</SheetDescription>
        </VisuallyHidden.Root>

        {displayed && (
          <div className="flex h-full min-h-0 flex-col">
            {/* Header */}
            <div className="flex-none border-b border-border/60 px-4 py-3">
              <div className="flex items-start gap-2">
                <LinearIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-[12px] text-muted-foreground">
                    {displayed.identifier}
                  </span>
                  <h2 className="mt-1 text-[15px] font-semibold leading-tight text-foreground">
                    {displayed.title}
                  </h2>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    {displayed.team?.name && <span>{displayed.team.name}</span>}
                    <span>· {formatRelativeTime(displayed.updatedAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => window.api.shell.openUrl(displayed.url)}
                        aria-label="Open on Linear"
                      >
                        <ExternalLink className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      Open on Linear
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={onClose}
                        aria-label="Close preview"
                      >
                        <X className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      Close · Esc
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>

            {/* Edit section */}
            {editState && (
              <EditSection
                issue={displayed}
                editState={editState}
                onEditStateChange={handleEditStateChange}
              />
            )}

            {/* Body + comments */}
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
              <div className="px-4 py-4">
                {displayed.description?.trim() ? (
                  <CommentMarkdown
                    content={displayed.description}
                    className="text-[14px] leading-relaxed"
                  />
                ) : (
                  <span className="italic text-muted-foreground">No description provided.</span>
                )}
              </div>

              <div className="border-t border-border/40 px-4 py-4">
                <div className="flex items-center gap-2 pb-3">
                  <span className="text-[13px] font-medium text-foreground">Comments</span>
                  {comments.length > 0 && (
                    <span className="text-[12px] text-muted-foreground">{comments.length}</span>
                  )}
                </div>
                {commentsLoading && comments.length === 0 ? (
                  <div className="flex items-center justify-center py-6">
                    <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                  </div>
                ) : comments.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">No comments yet.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {comments.map((comment) => (
                      <div
                        key={comment.id}
                        className="rounded-lg border border-border/40 bg-background/30"
                      >
                        <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
                          {comment.user?.avatarUrl && (
                            <img
                              src={comment.user.avatarUrl}
                              alt={comment.user.displayName}
                              className="size-5 shrink-0 rounded-full"
                            />
                          )}
                          <span className="text-[13px] font-semibold text-foreground">
                            {comment.user?.displayName ?? 'Unknown'}
                          </span>
                          <span className="text-[12px] text-muted-foreground">
                            · {formatRelativeTime(comment.createdAt)}
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
              </div>
            </div>

            {/* Comment footer + Start workspace */}
            <CommentFooter issueId={displayed.id} onCommentAdded={handleCommentAdded} />
            <div className="flex-none border-t border-border/60 bg-background/40 px-4 py-3">
              <Button
                onClick={() => onUse(displayed)}
                className="w-full justify-center gap-2"
                aria-label="Start workspace from issue"
              >
                Start workspace from issue
                <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
