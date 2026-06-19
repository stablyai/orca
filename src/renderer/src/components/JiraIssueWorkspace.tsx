/* eslint-disable max-lines -- Why: the Jira drawer co-locates preview,
   metadata edits, and comments so the task page has one full issue surface. */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: Jira issue hydration, comments, transitions, priorities, and user options are loaded from provider IPC for the selected issue. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
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
import { JiraIcon } from '@/components/icons/JiraIcon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import {
  jiraAddIssueComment,
  jiraGetIssue,
  jiraIssueComments,
  jiraListAssignableUsers,
  jiraListPriorities,
  jiraListTransitions,
  jiraUpdateIssue
} from '@/runtime/runtime-jira-client'
import type {
  JiraComment,
  JiraIssue,
  JiraPriority,
  JiraTransition,
  JiraUser
} from '../../../shared/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'

type JiraIssueWorkspaceProps = {
  issue: JiraIssue | null
  onUse: (issue: JiraIssue) => void
  onClose: () => void
  sourceContext?: TaskSourceContext | null
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

function buildJiraBranchName(issue: JiraIssue): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
  return `${issue.key.toLowerCase()}${slug ? `-${slug}` : ''}`
}

function buildJiraPrompt(issue: JiraIssue): string {
  return `Complete Jira issue ${issue.key}: ${issue.title}\n\n${issue.url}`
}

function jiraStatusClass(categoryKey: string): string {
  if (categoryKey === 'done') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (categoryKey === 'indeterminate') {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200'
  }
  return 'border-border/50 bg-muted/40 text-muted-foreground'
}

async function copyTextToClipboard(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.JiraIssueWorkspace.2ff69a3545', '{{value0}} copied', {
        value0: label
      })
    )
  } catch {
    toast.error(
      translate('auto.components.JiraIssueWorkspace.6c41a9bcea', 'Failed to copy {{value0}}', {
        value0: label.toLowerCase()
      })
    )
  }
}

export default function JiraIssueWorkspace({
  issue,
  onUse,
  onClose,
  sourceContext
}: JiraIssueWorkspaceProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? settings
  const patchJiraIssue = useAppStore((s) => s.patchJiraIssue)
  const [fullIssue, setFullIssue] = useState<JiraIssue | null>(null)
  const [issueLoading, setIssueLoading] = useState(false)
  const [comments, setComments] = useState<JiraComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [transitions, setTransitions] = useState<JiraTransition[]>([])
  const [priorities, setPriorities] = useState<JiraPriority[]>([])
  const [users, setUsers] = useState<JiraUser[]>([])
  const [pendingField, setPendingField] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [labelsDraft, setLabelsDraft] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const requestIdRef = useRef(0)
  const optimisticCommentsRef = useRef<JiraComment[]>([])

  const displayed = fullIssue ?? issue
  const siteId = displayed?.siteId ?? undefined

  const loadComments = useCallback(
    async (targetIssue: JiraIssue, requestId: number): Promise<void> => {
      setCommentsLoading(true)
      setCommentsError(null)
      try {
        let fetched = await jiraIssueComments(providerSettings, targetIssue.key, targetIssue.siteId)
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
    [providerSettings]
  )

  useEffect(() => {
    if (!issue) {
      setFullIssue(null)
      setIssueLoading(false)
      setComments([])
      setCommentsError(null)
      setTransitions([])
      setPriorities([])
      setUsers([])
      setCommentDraft('')
      optimisticCommentsRef.current = []
      return
    }

    requestIdRef.current += 1
    const requestId = requestIdRef.current
    optimisticCommentsRef.current = []
    setFullIssue(issue)
    setTitleDraft(issue.title)
    setLabelsDraft(issue.labels.join(', '))
    setComments([])
    setCommentsError(null)
    setIssueLoading(true)

    void jiraGetIssue(providerSettings, issue.key, issue.siteId)
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (result) {
          setFullIssue(result)
          setTitleDraft(result.title)
          setLabelsDraft(result.labels.join(', '))
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setIssueLoading(false)
        }
      })

    void Promise.all([
      jiraListTransitions(providerSettings, issue.key, issue.siteId),
      jiraListPriorities(providerSettings, issue.siteId),
      jiraListAssignableUsers(providerSettings, issue.key, undefined, issue.siteId)
    ])
      .then(([nextTransitions, nextPriorities, nextUsers]) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setTransitions(nextTransitions)
        setPriorities(nextPriorities)
        setUsers(nextUsers)
      })
      .catch(() => {})

    void loadComments(issue, requestId)
  }, [issue, loadComments, providerSettings])

  const refreshIssue = useCallback(async (): Promise<void> => {
    if (!displayed) {
      return
    }
    try {
      const latest = await jiraGetIssue(providerSettings, displayed.key, displayed.siteId)
      if (latest) {
        setFullIssue(latest)
        patchJiraIssue(latest.key, latest, { sourceContext })
      }
    } catch {
      // Keep the visible issue snapshot if refresh fails.
    }
  }, [displayed, patchJiraIssue, providerSettings, sourceContext])

  const mutateIssue = useCallback(
    async (
      field: string,
      updates: Parameters<typeof jiraUpdateIssue>[2],
      optimistic?: Partial<JiraIssue>
    ): Promise<void> => {
      if (!displayed || pendingField) {
        return
      }
      setPendingField(field)
      const previous = displayed
      try {
        if (optimistic) {
          setFullIssue({ ...displayed, ...optimistic })
          patchJiraIssue(displayed.key, optimistic, { sourceContext })
        }
        const result = await jiraUpdateIssue(providerSettings, displayed.key, updates, siteId)
        if (!result.ok) {
          throw new Error(result.error)
        }
        await refreshIssue()
      } catch (error) {
        setFullIssue(previous)
        patchJiraIssue(previous.key, previous, { sourceContext })
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.JiraIssueWorkspace.ea21952aa3',
                'Failed to update Jira issue.'
              )
        )
      } finally {
        setPendingField(null)
      }
    },
    [displayed, patchJiraIssue, pendingField, refreshIssue, providerSettings, siteId, sourceContext]
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
    void mutateIssue('title', { title }, { title })
  }, [displayed, mutateIssue, titleDraft])

  const handleSaveLabels = useCallback(() => {
    if (!displayed) {
      return
    }
    const labels = labelsDraft
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean)
    void mutateIssue('labels', { labels }, { labels })
  }, [displayed, labelsDraft, mutateIssue])

  const handleSubmitComment = useCallback(async (): Promise<void> => {
    if (!displayed || commentSubmitting) {
      return
    }
    const body = commentDraft.trim()
    if (!body) {
      return
    }
    setCommentSubmitting(true)
    try {
      const result = await jiraAddIssueComment(
        providerSettings,
        displayed.key,
        body,
        displayed.siteId
      )
      if (!result.ok) {
        throw new Error(result.error)
      }
      const comment: JiraComment = {
        id: result.id || createBrowserUuid(),
        body,
        createdAt: new Date().toISOString(),
        user: { accountId: 'local', displayName: 'You' }
      }
      optimisticCommentsRef.current.push(comment)
      setComments((prev) => [...prev, comment])
      setCommentDraft('')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.JiraIssueWorkspace.fa132c8aed', 'Failed to add comment.')
      )
    } finally {
      setCommentSubmitting(false)
    }
  }, [commentDraft, commentSubmitting, displayed, providerSettings])

  const actionItems = useMemo(() => {
    if (!displayed) {
      return []
    }
    return [
      {
        label: translate('auto.components.JiraIssueWorkspace.69da9a208c', 'Open in Jira'),
        icon: ExternalLink,
        action: () => window.api.shell.openUrl(displayed.url)
      },
      {
        label: translate('auto.components.JiraIssueWorkspace.779bb91ee0', 'Copy URL'),
        icon: Clipboard,
        action: () => void copyTextToClipboard(displayed.url, 'URL')
      },
      {
        label: translate('auto.components.JiraIssueWorkspace.38839801e8', 'Copy key'),
        icon: Clipboard,
        action: () => void copyTextToClipboard(displayed.key, 'Key')
      },
      {
        label: translate(
          'auto.components.JiraIssueWorkspace.80efa101c5',
          'Copy suggested branch name'
        ),
        icon: GitBranch,
        action: () => void copyTextToClipboard(buildJiraBranchName(displayed), 'Branch name')
      },
      {
        label: translate('auto.components.JiraIssueWorkspace.0cc62bd690', 'Copy prompt'),
        icon: Clipboard,
        action: () => void copyTextToClipboard(buildJiraPrompt(displayed), 'Prompt')
      }
    ]
  }, [displayed])

  return (
    <Sheet open={issue !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,780px)] p-0 sm:max-w-[780px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {displayed?.title ??
              translate('auto.components.JiraIssueWorkspace.ef21405c6d', 'Jira issue')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.JiraIssueWorkspace.857bd2f88f',
              'Preview, edit, and start work from the selected issue.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {displayed ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="font-mono">{displayed.key}</span>
                    {displayed.siteName ? <span>{displayed.siteName}</span> : null}
                    <span>{displayed.project.key}</span>
                    <span>{formatRelativeTime(displayed.updatedAt)}</span>
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
                  {translate('auto.components.JiraIssueWorkspace.2441be6f9f', 'Start workspace')}
                  <ArrowRight className="size-4" />
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      onClick={onClose}
                      aria-label={translate(
                        'auto.components.JiraIssueWorkspace.76513c7898',
                        'Close Jira issue preview'
                      )}
                    >
                      <X className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {translate('auto.components.JiraIssueWorkspace.7a96985ca0', 'Close')}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={pendingField === 'transition' || transitions.length === 0}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition hover:opacity-80 disabled:opacity-50',
                      jiraStatusClass(displayed.status.categoryKey)
                    )}
                  >
                    {displayed.status.name}
                    {pendingField === 'transition' ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : null}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="popover-scroll-content scrollbar-sleek w-52 p-1"
                  align="start"
                >
                  {transitions.map((transition) => (
                    <button
                      key={transition.id}
                      type="button"
                      onClick={() =>
                        void mutateIssue(
                          'transition',
                          { transitionId: transition.id },
                          { status: transition.to }
                        )
                      }
                      className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
                    >
                      {transition.name}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>

              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={pendingField === 'priority'}
                    className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted/40 disabled:opacity-50"
                  >
                    {displayed.priority?.name ??
                      translate('auto.components.JiraIssueWorkspace.51bed73f88', 'No priority')}
                    {pendingField === 'priority' ? (
                      <LoaderCircle className="ml-1 inline size-3 animate-spin" />
                    ) : null}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="popover-scroll-content scrollbar-sleek w-48 p-1"
                  align="start"
                >
                  <button
                    type="button"
                    onClick={() =>
                      void mutateIssue('priority', { priorityId: null }, { priority: undefined })
                    }
                    className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
                  >
                    {translate('auto.components.JiraIssueWorkspace.51bed73f88', 'No priority')}
                  </button>
                  {priorities.map((priority) => (
                    <button
                      key={priority.id}
                      type="button"
                      onClick={() =>
                        void mutateIssue('priority', { priorityId: priority.id }, { priority })
                      }
                      className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
                    >
                      {priority.name}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>

              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={pendingField === 'assignee'}
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted/40 disabled:opacity-50"
                  >
                    {displayed.assignee?.displayName ??
                      translate('auto.components.JiraIssueWorkspace.54649eaeab', '+ Assignee')}
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
                      void mutateIssue(
                        'assignee',
                        { assigneeAccountId: null },
                        { assignee: undefined }
                      )
                    }
                    className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
                  >
                    {translate('auto.components.JiraIssueWorkspace.0b6b5646ed', 'Unassigned')}
                  </button>
                  {users.map((user) => (
                    <button
                      key={user.accountId}
                      type="button"
                      onClick={() =>
                        void mutateIssue(
                          'assignee',
                          { assigneeAccountId: user.accountId },
                          { assignee: user }
                        )
                      }
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
                    >
                      {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt="" className="size-5 rounded-full" />
                      ) : null}
                      <span className="truncate">{user.displayName}</span>
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_228px]">
              <div className="min-h-0 overflow-y-auto scrollbar-sleek">
                <section className="border-b border-border/40 px-4 py-4">
                  <div className="grid gap-2">
                    <label className="text-[11px] font-medium text-muted-foreground">
                      {translate('auto.components.JiraIssueWorkspace.444865b4a8', 'Title')}
                    </label>
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
                    <label className="mt-2 text-[11px] font-medium text-muted-foreground">
                      {translate('auto.components.JiraIssueWorkspace.aee97b6913', 'Labels')}
                    </label>
                    <div className="flex gap-2">
                      <Input
                        value={labelsDraft}
                        onChange={(event) => setLabelsDraft(event.target.value)}
                        placeholder={translate(
                          'auto.components.JiraIssueWorkspace.0f3c07a901',
                          'backend, bug'
                        )}
                        className="h-8 text-xs"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleSaveLabels}
                        disabled={pendingField === 'labels'}
                      >
                        {pendingField === 'labels' ? (
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
                    <JiraIcon className="size-3 text-muted-foreground" />
                    <span className="text-xs font-medium text-foreground">
                      {displayed.issueType.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {displayed.project.key} ·{' '}
                      {displayed.assignee?.displayName ??
                        translate('auto.components.JiraIssueWorkspace.0b6b5646ed', 'Unassigned')}
                    </span>
                  </div>
                  {displayed.description?.trim() ? (
                    <CommentMarkdown
                      content={displayed.description}
                      className="text-[14px] leading-relaxed"
                    />
                  ) : (
                    <p className="text-sm italic text-muted-foreground">
                      {translate(
                        'auto.components.JiraIssueWorkspace.c4889a47e4',
                        'No description provided.'
                      )}
                    </p>
                  )}
                </section>

                <section className="px-4 py-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-foreground">
                        {translate('auto.components.JiraIssueWorkspace.9a980b06b9', 'Comments')}
                      </span>
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
                        {translate('auto.components.JiraIssueWorkspace.5cd09beaf9', 'Retry')}
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
                    <p className="text-sm text-muted-foreground">
                      {translate(
                        'auto.components.JiraIssueWorkspace.9178090e26',
                        'No comments yet.'
                      )}
                    </p>
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
                                alt=""
                                className="size-5 shrink-0 rounded-full"
                              />
                            ) : null}
                            <span className="truncate text-[13px] font-semibold text-foreground">
                              {comment.user?.displayName ??
                                translate(
                                  'auto.components.JiraIssueWorkspace.666cfdd835',
                                  'Unknown'
                                )}
                            </span>
                            <span className="shrink-0 text-[12px] text-muted-foreground">
                              {formatRelativeTime(comment.createdAt)}
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
                  {translate('auto.components.JiraIssueWorkspace.2441be6f9f', 'Start workspace')}
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
                  placeholder={translate(
                    'auto.components.JiraIssueWorkspace.a585fd204e',
                    'Add a Jira comment...'
                  )}
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
                  {translate('auto.components.JiraIssueWorkspace.b0b92666c9', 'Comment')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
