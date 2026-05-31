/* eslint-disable max-lines -- Why: dialog co-locates header, three
   tabs (Description / Conversation / Pipeline), comment composer,
   and four mutation actions. Splitting any of these into separate
   components would make the close/reopen/merge state coupling
   non-obvious. The GitHub-side equivalent (GitHubItemDialog) carries
   the same disable for the same reason. */
/* Why: GitLab counterpart to GitHubItemDialog. Side sheet with three
   tabs (Description / Conversation / Pipeline) and footer actions —
   close/reopen, merge, and a top-level comment composer. Files /
   inline review-comment positioning / approvals are deferred to v1.5
   since they mirror substantial GitHub-side surface area. */
import React, { useCallback, useEffect, useState } from 'react'
import {
  Check,
  CircleDot,
  ExternalLink,
  GitMerge,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Send,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VisuallyHidden } from 'radix-ui'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { useMountedRef } from '@/hooks/useMountedRef'
import { cn } from '@/lib/utils'
import type {
  GitLabAssignableUser,
  GitLabPipelineJob,
  GitLabMRUpdate,
  GitLabWorkItem,
  GitLabWorkItemDetails,
  MRComment
} from '../../../shared/types'

type Props = {
  item: GitLabWorkItem | null
  repoPath: string | null
  onClose: () => void
  onCreateWorkspace?: (item: GitLabWorkItem) => void
}

type JobTraceState = {
  loading: boolean
  trace?: string
  error?: string
}

// Why: GitLab MR / issue states map onto a coarser palette than GitHub.
const STATE_TONE: Record<GitLabWorkItem['state'], string> = {
  opened: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  closed: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  merged: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  locked: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  draft: 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
}

// Why: pipeline job statuses map to one of four visual buckets — keep
// the mapping local so the renderer doesn't depend on the backend's
// shared mapper module (which is main-process only).
function jobStatusTone(status: string): string {
  switch (status) {
    case 'success':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
    case 'failed':
      return 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
    case 'running':
    case 'pending':
    case 'created':
    case 'preparing':
    case 'waiting_for_resource':
    case 'scheduled':
      return 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
    case 'manual':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
    case 'canceled':
    case 'skipped':
    default:
      return 'bg-muted text-muted-foreground'
  }
}

function StateBadge({ state }: { state: GitLabWorkItem['state'] }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        STATE_TONE[state]
      )}
    >
      {state}
    </span>
  )
}

function normalizeGitLabLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const label of labels) {
    const trimmed = label.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) {
      continue
    }
    seen.add(key)
    normalized.push(trimmed)
  }
  return normalized
}

function parseGitLabLabelDraft(value: string): string[] {
  return normalizeGitLabLabels(value.split(','))
}

function formatGitLabLabelDraft(labels: readonly string[]): string {
  return normalizeGitLabLabels(labels).join(', ')
}

function toggleGitLabLabelDraft(value: string, label: string): string {
  const labels = parseGitLabLabelDraft(value)
  const key = label.trim().toLowerCase()
  const next = labels.some((item) => item.toLowerCase() === key)
    ? labels.filter((item) => item.toLowerCase() !== key)
    : [...labels, label]
  return formatGitLabLabelDraft(next)
}

function gitLabUserKey(user: GitLabAssignableUser): string {
  return typeof user.id === 'number' ? `id:${user.id}` : `username:${user.username.toLowerCase()}`
}

function dedupeGitLabUsers(users: readonly GitLabAssignableUser[]): GitLabAssignableUser[] {
  const byKey = new Map<string, GitLabAssignableUser>()
  for (const user of users) {
    byKey.set(gitLabUserKey(user), user)
  }
  return Array.from(byKey.values()).sort((a, b) => a.username.localeCompare(b.username))
}

function CommentCard({
  comment,
  canResolve,
  resolving,
  onResolve
}: {
  comment: MRComment
  canResolve?: boolean
  resolving?: boolean
  onResolve?: (threadId: string, resolved: boolean) => void
}): React.JSX.Element {
  const hasThread = Boolean(comment.threadId)
  return (
    <div className="rounded-md border border-border/40 bg-muted/30 p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          {comment.authorAvatarUrl ? (
            <img
              src={comment.authorAvatarUrl}
              alt=""
              className="size-5 rounded-full"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          ) : null}
          <span className="font-medium text-foreground">{comment.author}</span>
          {comment.isResolved ? (
            <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
              resolved
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {canResolve && hasThread && onResolve ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={resolving}
              onClick={() => onResolve(comment.threadId ?? '', !comment.isResolved)}
              className="h-6"
            >
              {resolving ? <LoaderCircle className="size-3 animate-spin" /> : null}
              {comment.isResolved ? 'Reopen' : 'Resolve'}
            </Button>
          ) : null}
          <span>{comment.createdAt ? new Date(comment.createdAt).toLocaleDateString() : ''}</span>
        </div>
      </div>
      {comment.path ? (
        <div className="mb-1.5 font-mono text-[11px] text-muted-foreground">
          {comment.path}
          {comment.line ? `:${comment.line}` : ''}
        </div>
      ) : null}
      <CommentMarkdown content={comment.body} />
    </div>
  )
}

function PipelineJobRow({
  job,
  expanded,
  traceState,
  retrying,
  onToggleTrace,
  onRetry
}: {
  job: GitLabPipelineJob
  expanded: boolean
  traceState?: JobTraceState
  retrying: boolean
  onToggleTrace: (job: GitLabPipelineJob) => void
  onRetry: (job: GitLabPipelineJob) => void
}): React.JSX.Element {
  const canRetry = ['failed', 'canceled', 'cancelled'].includes(job.status)
  return (
    <div className="rounded-md">
      <div className="grid w-full grid-cols-[minmax(0,2fr)_minmax(0,1fr)_80px_64px_96px] items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/40">
        <button
          type="button"
          onClick={() => onToggleTrace(job)}
          className="min-w-0 truncate text-left font-medium"
        >
          {job.name}
        </button>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{job.stage}</span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-center text-[10px] font-medium uppercase tracking-wide',
            jobStatusTone(job.status)
          )}
        >
          {job.status}
        </span>
        <span className="text-right text-[11px] text-muted-foreground">
          {/* Why: durations come back as seconds; show "Nm Ns" for >60s
              and "Ns" otherwise. null = job hasn't finished. */}
          {typeof job.duration === 'number'
            ? job.duration >= 60
              ? `${Math.floor(job.duration / 60)}m ${Math.floor(job.duration % 60)}s`
              : `${Math.floor(job.duration)}s`
            : '—'}
        </span>
        <div className="flex justify-end gap-1">
          {canRetry ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={retrying}
              onClick={() => onRetry(job)}
              className="h-6"
            >
              {retrying ? <LoaderCircle className="size-3 animate-spin" /> : null}
              Retry
            </Button>
          ) : null}
          {job.webUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void window.api.shell.openUrl(job.webUrl)}
              title="Open job in GitLab"
            >
              <ExternalLink className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <div className="mx-3 mb-2 rounded-md border border-border/50 bg-muted/20">
          <div className="flex items-center justify-between border-b border-border/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <span>Job log</span>
            <Button type="button" variant="ghost" size="xs" onClick={() => onToggleTrace(job)}>
              Hide
            </Button>
          </div>
          {traceState?.loading ? (
            <div className="flex items-center gap-2 px-2.5 py-3 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />
              Loading log
            </div>
          ) : traceState?.error ? (
            <div className="px-2.5 py-3 text-xs text-destructive">{traceState.error}</div>
          ) : (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-4 text-foreground scrollbar-sleek">
              {traceState?.trace?.trim() ? traceState.trace : 'No log output.'}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default function GitLabItemDialog({
  item,
  repoPath,
  onClose,
  onCreateWorkspace
}: Props): React.JSX.Element {
  const [details, setDetails] = useState<GitLabWorkItemDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const [resolvingThreadId, setResolvingThreadId] = useState<string | null>(null)
  const [editingDetails, setEditingDetails] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [bodyDraft, setBodyDraft] = useState('')
  const [labelDraft, setLabelDraft] = useState('')
  const [labelOptions, setLabelOptions] = useState<string[] | null>(null)
  const [labelOptionsLoading, setLabelOptionsLoading] = useState(false)
  const [detailsSaving, setDetailsSaving] = useState(false)
  const [reviewerOptions, setReviewerOptions] = useState<GitLabAssignableUser[] | null>(null)
  const [reviewerOptionsLoading, setReviewerOptionsLoading] = useState(false)
  const [reviewerUpdating, setReviewerUpdating] = useState(false)
  const [reviewerDraftId, setReviewerDraftId] = useState('')
  const [inlineCommentFilePath, setInlineCommentFilePath] = useState('')
  const [inlineCommentLine, setInlineCommentLine] = useState('')
  const [inlineCommentBody, setInlineCommentBody] = useState('')
  const [inlineCommentSubmitting, setInlineCommentSubmitting] = useState(false)
  const [expandedJobId, setExpandedJobId] = useState<number | null>(null)
  const [jobTraceById, setJobTraceById] = useState<Record<number, JobTraceState>>({})
  const [retryingJobId, setRetryingJobId] = useState<number | null>(null)
  const [actionInFlight, setActionInFlight] = useState<'close' | 'reopen' | 'merge' | null>(null)
  const mountedRef = useMountedRef()

  useEffect(() => {
    if (!item || !repoPath) {
      setDetails(null)
      setLoading(false)
      setError(null)
      setEditingDetails(false)
      return
    }
    let stale = false
    setLoading(true)
    setError(null)
    void window.api.gl
      .workItemDetails({ repoPath, iid: item.number, type: item.type })
      .then((data) => {
        if (stale) {
          return
        }
        if (!data) {
          setError('Item not found.')
          return
        }
        setDetails(data as GitLabWorkItemDetails)
      })
      .catch((err) => {
        if (!stale) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [item, repoPath, refreshNonce])

  // Why: clear the comment draft when the sheet target changes so the
  // user doesn't accidentally post one MR's draft against another.
  useEffect(() => {
    setCommentDraft('')
    setEditingDetails(false)
    setTitleDraft('')
    setBodyDraft('')
    setLabelDraft('')
    setLabelOptions(null)
    setLabelOptionsLoading(false)
    setReviewerOptions(null)
    setReviewerOptionsLoading(false)
    setReviewerUpdating(false)
    setReviewerDraftId('')
    setInlineCommentFilePath('')
    setInlineCommentLine('')
    setInlineCommentBody('')
    setInlineCommentSubmitting(false)
    setExpandedJobId(null)
    setJobTraceById({})
    setRetryingJobId(null)
  }, [item?.id])

  const handleRefresh = useCallback(() => {
    setRefreshNonce((n) => n + 1)
  }, [])

  const loadGitLabLabelOptions = useCallback(async (): Promise<void> => {
    if (!repoPath || labelOptions !== null || labelOptionsLoading) {
      return
    }
    setLabelOptionsLoading(true)
    try {
      const labels = await window.api.gl.listLabels({ repoPath })
      if (mountedRef.current) {
        setLabelOptions(normalizeGitLabLabels(labels))
      }
    } catch {
      if (mountedRef.current) {
        setLabelOptions([])
      }
    } finally {
      if (mountedRef.current) {
        setLabelOptionsLoading(false)
      }
    }
  }, [labelOptions, labelOptionsLoading, mountedRef, repoPath])

  const loadGitLabReviewerOptions = useCallback(async (): Promise<void> => {
    if (!repoPath || reviewerOptions !== null || reviewerOptionsLoading) {
      return
    }
    setReviewerOptionsLoading(true)
    try {
      const users = await window.api.gl.listAssignableUsers({ repoPath })
      if (mountedRef.current) {
        setReviewerOptions(dedupeGitLabUsers(users))
      }
    } catch {
      if (mountedRef.current) {
        setReviewerOptions([])
      }
    } finally {
      if (mountedRef.current) {
        setReviewerOptionsLoading(false)
      }
    }
  }, [mountedRef, repoPath, reviewerOptions, reviewerOptionsLoading])

  const handleStartDetailsEdit = useCallback((): void => {
    if (!item || !details || item.type !== 'mr') {
      return
    }
    setTitleDraft(details.item.title || item.title)
    setBodyDraft(details.body)
    setLabelDraft(formatGitLabLabelDraft(details.item.labels ?? item.labels))
    setEditingDetails(true)
    void loadGitLabLabelOptions()
  }, [details, item, loadGitLabLabelOptions])

  const handleCancelDetailsEdit = useCallback((): void => {
    setEditingDetails(false)
    setTitleDraft('')
    setBodyDraft('')
    setLabelDraft('')
  }, [])

  const handleSaveDetails = useCallback(async (): Promise<void> => {
    if (!item || !details || !repoPath || item.type !== 'mr') {
      return
    }
    const currentTitle = details.item.title || item.title
    const currentBody = details.body
    const currentLabels = normalizeGitLabLabels(details.item.labels ?? item.labels)
    const nextTitle = titleDraft.trim()
    const nextBody = bodyDraft
    const nextLabels = parseGitLabLabelDraft(labelDraft)
    if (!nextTitle) {
      toast.error('MR title is required.')
      return
    }

    const currentLabelKeys = new Set(currentLabels.map((label) => label.toLowerCase()))
    const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()))
    const addLabels = nextLabels.filter((label) => !currentLabelKeys.has(label.toLowerCase()))
    const removeLabels = currentLabels.filter((label) => !nextLabelKeys.has(label.toLowerCase()))
    const updates: GitLabMRUpdate = {}
    if (nextTitle !== currentTitle) {
      updates.title = nextTitle
    }
    if (nextBody !== currentBody) {
      updates.body = nextBody
    }
    if (addLabels.length > 0) {
      updates.addLabels = addLabels
    }
    if (removeLabels.length > 0) {
      updates.removeLabels = removeLabels
    }
    if (Object.keys(updates).length === 0) {
      handleCancelDetailsEdit()
      return
    }

    setDetailsSaving(true)
    try {
      const res = await window.api.gl.updateMR({ repoPath, iid: item.number, updates })
      if (res.ok) {
        if (mountedRef.current) {
          setDetails((current) =>
            current
              ? {
                  ...current,
                  body: nextBody,
                  item: { ...current.item, title: nextTitle, labels: nextLabels }
                }
              : current
          )
          setLabelOptions((current) =>
            current ? normalizeGitLabLabels([...current, ...nextLabels]) : current
          )
          setEditingDetails(false)
          setTitleDraft('')
          setBodyDraft('')
          setLabelDraft('')
        }
      } else if (mountedRef.current) {
        toast.error(res.error)
      }
    } finally {
      if (mountedRef.current) {
        setDetailsSaving(false)
      }
    }
  }, [
    bodyDraft,
    details,
    handleCancelDetailsEdit,
    item,
    labelDraft,
    mountedRef,
    repoPath,
    titleDraft
  ])

  const handleToggleJobTrace = useCallback(
    async (job: GitLabPipelineJob): Promise<void> => {
      if (expandedJobId === job.id) {
        setExpandedJobId(null)
        return
      }
      setExpandedJobId(job.id)
      if (!repoPath || !item || jobTraceById[job.id]?.trace || jobTraceById[job.id]?.error) {
        return
      }
      setJobTraceById((current) => ({
        ...current,
        [job.id]: { loading: true }
      }))
      try {
        const result = await window.api.gl.jobTrace({
          repoPath,
          jobId: job.id,
          projectRef: details?.item.projectRef ?? item.projectRef ?? null
        })
        if (!mountedRef.current) {
          return
        }
        setJobTraceById((current) => ({
          ...current,
          [job.id]: result.ok
            ? { loading: false, trace: result.trace }
            : { loading: false, error: result.error }
        }))
      } catch (error) {
        if (mountedRef.current) {
          setJobTraceById((current) => ({
            ...current,
            [job.id]: {
              loading: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }))
        }
      }
    },
    [details?.item.projectRef, expandedJobId, item, jobTraceById, mountedRef, repoPath]
  )

  const handleRetryJob = useCallback(
    async (job: GitLabPipelineJob): Promise<void> => {
      if (!repoPath || !item) {
        return
      }
      setRetryingJobId(job.id)
      try {
        const result = await window.api.gl.retryJob({
          repoPath,
          jobId: job.id,
          projectRef: details?.item.projectRef ?? item.projectRef ?? null
        })
        if (!mountedRef.current) {
          return
        }
        if (result.ok) {
          toast.success(`Retried ${job.name}`)
          if (result.job) {
            setDetails((current) =>
              current
                ? {
                    ...current,
                    pipelineJobs: (current.pipelineJobs ?? []).map((existing) =>
                      existing.id === job.id ? result.job! : existing
                    )
                  }
                : current
            )
          }
          handleRefresh()
        } else {
          toast.error(result.error)
        }
      } finally {
        if (mountedRef.current) {
          setRetryingJobId(null)
        }
      }
    },
    [details?.item.projectRef, handleRefresh, item, mountedRef, repoPath]
  )

  const handleSetReviewers = useCallback(
    async (nextReviewers: GitLabAssignableUser[]): Promise<void> => {
      if (!repoPath || !item || !details || item.type !== 'mr') {
        return
      }
      const reviewerIds = nextReviewers
        .map((reviewer) => reviewer.id)
        .filter((id): id is number => typeof id === 'number')
      if (reviewerIds.length !== nextReviewers.length) {
        toast.error('Reviewer id is unavailable for this GitLab user.')
        return
      }
      setReviewerUpdating(true)
      try {
        const result = await window.api.gl.updateMRReviewers({
          repoPath,
          iid: item.number,
          reviewerIds,
          projectRef: details.item.projectRef ?? item.projectRef ?? null
        })
        if (!mountedRef.current) {
          return
        }
        if (result.ok) {
          setDetails((current) =>
            current ? { ...current, reviewers: dedupeGitLabUsers(result.reviewers) } : current
          )
          setReviewerDraftId('')
          setReviewerOptions((current) =>
            current ? dedupeGitLabUsers([...current, ...result.reviewers]) : current
          )
        } else {
          toast.error(result.error)
        }
      } finally {
        if (mountedRef.current) {
          setReviewerUpdating(false)
        }
      }
    },
    [details, item, mountedRef, repoPath]
  )

  const handleSubmitInlineComment = useCallback(async (): Promise<void> => {
    if (!repoPath || !item || !details || item.type !== 'mr') {
      return
    }
    const file = (details.files ?? []).find((row) => row.path === inlineCommentFilePath)
    const line = Number.parseInt(inlineCommentLine, 10)
    const body = inlineCommentBody.trim()
    if (!file || !Number.isFinite(line) || line <= 0 || !body) {
      toast.error('File, line, and comment are required.')
      return
    }
    if (!details.baseSha || !details.startSha || !details.headSha) {
      toast.error('MR diff refs are unavailable for inline comments.')
      return
    }
    setInlineCommentSubmitting(true)
    try {
      const result = await window.api.gl.addMRInlineComment({
        repoPath,
        iid: item.number,
        projectRef: details.item.projectRef ?? item.projectRef ?? null,
        input: {
          body,
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          line,
          baseSha: details.baseSha,
          startSha: details.startSha,
          headSha: details.headSha
        }
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setDetails((current) =>
          current ? { ...current, comments: [...current.comments, result.comment] } : current
        )
        setInlineCommentBody('')
        toast.success('Inline comment added')
      } else {
        toast.error(result.error)
      }
    } finally {
      if (mountedRef.current) {
        setInlineCommentSubmitting(false)
      }
    }
  }, [
    details,
    inlineCommentBody,
    inlineCommentFilePath,
    inlineCommentLine,
    item,
    mountedRef,
    repoPath
  ])

  const handleClose = useCallback(async (): Promise<void> => {
    if (!item || !repoPath || item.type !== 'mr') {
      return
    }
    setActionInFlight('close')
    try {
      const res = await window.api.gl.closeMR({ repoPath, iid: item.number })
      if (res.ok) {
        if (mountedRef.current) {
          toast.success(`Closed MR !${item.number}`)
          handleRefresh()
        }
      } else {
        if (mountedRef.current) {
          toast.error(res.error)
        }
      }
    } finally {
      if (mountedRef.current) {
        setActionInFlight(null)
      }
    }
  }, [item, repoPath, mountedRef, handleRefresh])

  const handleReopen = useCallback(async (): Promise<void> => {
    if (!item || !repoPath || item.type !== 'mr') {
      return
    }
    setActionInFlight('reopen')
    try {
      const res = await window.api.gl.reopenMR({ repoPath, iid: item.number })
      if (res.ok) {
        if (mountedRef.current) {
          toast.success(`Reopened MR !${item.number}`)
          handleRefresh()
        }
      } else {
        if (mountedRef.current) {
          toast.error(res.error)
        }
      }
    } finally {
      if (mountedRef.current) {
        setActionInFlight(null)
      }
    }
  }, [item, repoPath, mountedRef, handleRefresh])

  const handleMerge = useCallback(async (): Promise<void> => {
    if (!item || !repoPath || item.type !== 'mr') {
      return
    }
    setActionInFlight('merge')
    try {
      const res = await window.api.gl.mergeMR({ repoPath, iid: item.number })
      if (res.ok) {
        if (mountedRef.current) {
          toast.success(`Merged MR !${item.number}`)
          handleRefresh()
        }
      } else {
        if (mountedRef.current) {
          toast.error(res.error)
        }
      }
    } finally {
      if (mountedRef.current) {
        setActionInFlight(null)
      }
    }
  }, [item, repoPath, mountedRef, handleRefresh])

  const handleSubmitComment = useCallback(async (): Promise<void> => {
    const body = commentDraft.trim()
    if (!body || !item || !repoPath) {
      return
    }
    setCommentSubmitting(true)
    try {
      // Why: the IPC for issue comments takes `number`, MR takes `iid`.
      // Branch on the item type to hit the right channel.
      const res =
        item.type === 'mr'
          ? await window.api.gl.addMRComment({ repoPath, iid: item.number, body })
          : await window.api.gl.addIssueComment({ repoPath, number: item.number, body })
      if (res.ok) {
        if (mountedRef.current) {
          setCommentDraft('')
          handleRefresh()
        }
      } else {
        if (mountedRef.current) {
          toast.error(res.error)
        }
      }
    } finally {
      if (mountedRef.current) {
        setCommentSubmitting(false)
      }
    }
  }, [commentDraft, item, repoPath, mountedRef, handleRefresh])

  const handleResolveDiscussion = useCallback(
    async (threadId: string, resolved: boolean): Promise<void> => {
      if (!item || !repoPath || item.type !== 'mr') {
        return
      }
      setResolvingThreadId(threadId)
      try {
        const res = await window.api.gl.resolveMRDiscussion({
          repoPath,
          iid: item.number,
          discussionId: threadId,
          resolved
        })
        if (res.ok) {
          if (mountedRef.current) {
            setDetails((current) =>
              current
                ? {
                    ...current,
                    comments: current.comments.map((comment) =>
                      comment.threadId === threadId ? { ...comment, isResolved: resolved } : comment
                    )
                  }
                : current
            )
          }
        } else if (mountedRef.current) {
          toast.error(res.error)
        }
      } finally {
        if (mountedRef.current) {
          setResolvingThreadId(null)
        }
      }
    },
    [item, repoPath, mountedRef]
  )

  // Why: GitMerge for MRs visually disambiguates from GitBranch (and
  // matches gitlab.com's MR iconography); CircleDot stays on issues.
  const Icon = item?.type === 'mr' ? GitMerge : CircleDot
  const prefix = item?.type === 'mr' ? '!' : '#'
  const isMR = item?.type === 'mr'
  const canClose = isMR && item?.state === 'opened'
  const canReopen = isMR && item?.state === 'closed'
  const canMerge = isMR && item?.state === 'opened'
  const visibleTitle = details?.item.title || item?.title || ''
  const visibleLabels = normalizeGitLabLabels(details?.item.labels ?? item?.labels ?? [])
  const labelSuggestionOptions = normalizeGitLabLabels([
    ...(labelOptions ?? []),
    ...visibleLabels,
    ...parseGitLabLabelDraft(labelDraft)
  ])
  const currentReviewers = dedupeGitLabUsers(details?.reviewers ?? [])
  const currentReviewerKeys = new Set(currentReviewers.map(gitLabUserKey))
  const reviewerOptionRows = dedupeGitLabUsers([
    ...(reviewerOptions ?? []),
    ...currentReviewers
  ]).filter((user) => !currentReviewerKeys.has(gitLabUserKey(user)))
  const approvalState = details?.approvalState

  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <VisuallyHidden.Root>
          <SheetTitle>{item ? visibleTitle : 'Work item'}</SheetTitle>
          <SheetDescription>GitLab work item detail</SheetDescription>
        </VisuallyHidden.Root>

        {item ? (
          <>
            <header className="flex-none border-b border-border/40 px-5 py-4">
              <div className="flex items-start gap-3">
                <Icon className="mt-0.5 size-5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">
                      {prefix}
                      {item.number}
                    </span>
                    <StateBadge state={item.state} />
                    {item.author ? <span>by {item.author}</span> : null}
                  </div>
                  <h2 className="mt-1.5 text-lg font-semibold leading-tight text-foreground">
                    {visibleTitle}
                  </h2>
                  {visibleLabels.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {visibleLabels.map((label) => (
                        <span
                          key={label}
                          className="rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Refresh"
                  disabled={loading}
                  onClick={handleRefresh}
                  className="size-7"
                >
                  {loading ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                </Button>
              </div>
            </header>

            <Tabs defaultValue="description" className="flex min-h-0 flex-1 flex-col">
              <TabsList className="mx-5 mt-3 self-start">
                <TabsTrigger value="description">Description</TabsTrigger>
                <TabsTrigger value="conversation">
                  Conversation
                  {details?.comments?.length ? (
                    <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] font-medium">
                      {details.comments.length}
                    </span>
                  ) : null}
                </TabsTrigger>
                {isMR ? (
                  <TabsTrigger value="files">
                    Files
                    {details?.files?.length ? (
                      <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] font-medium">
                        {details.files.length}
                      </span>
                    ) : null}
                  </TabsTrigger>
                ) : null}
                {isMR ? (
                  <TabsTrigger value="pipeline">
                    Pipeline
                    {details?.pipelineJobs?.length ? (
                      <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] font-medium">
                        {details.pipelineJobs.length}
                      </span>
                    ) : null}
                  </TabsTrigger>
                ) : null}
              </TabsList>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-sleek">
                {error ? (
                  <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                ) : null}

                <TabsContent value="description" className="mt-0">
                  {!loading && details && isMR ? (
                    <div className="mb-4 rounded-md border border-border/50 bg-muted/20 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-medium text-foreground">Reviewers</div>
                          {approvalState ? (
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              {approvalState.approvalsLeft === 0
                                ? 'Approved'
                                : `${approvalState.approvalsLeft ?? 0} approval${
                                    approvalState.approvalsLeft === 1 ? '' : 's'
                                  } remaining`}
                              {typeof approvalState.approvalsRequired === 'number'
                                ? ` of ${approvalState.approvalsRequired} required`
                                : ''}
                            </div>
                          ) : null}
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={reviewerOptionsLoading}
                          onClick={() => void loadGitLabReviewerOptions()}
                        >
                          {reviewerOptionsLoading ? (
                            <LoaderCircle className="size-3 animate-spin" />
                          ) : null}
                          Manage
                        </Button>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {currentReviewers.length > 0 ? (
                          currentReviewers.map((reviewer) => (
                            <span
                              key={gitLabUserKey(reviewer)}
                              className="inline-flex h-6 items-center gap-1 rounded-full border border-border/50 bg-background px-2 text-[11px] text-foreground"
                            >
                              {reviewer.username}
                              <button
                                type="button"
                                disabled={reviewerUpdating}
                                onClick={() =>
                                  void handleSetReviewers(
                                    currentReviewers.filter(
                                      (row) => gitLabUserKey(row) !== gitLabUserKey(reviewer)
                                    )
                                  )
                                }
                                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                                aria-label={`Remove reviewer ${reviewer.username}`}
                              >
                                <X className="size-3" />
                              </button>
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] text-muted-foreground">No reviewers.</span>
                        )}
                      </div>
                      {reviewerOptions ? (
                        <div className="mt-2 flex items-center gap-2">
                          <select
                            value={reviewerDraftId}
                            disabled={reviewerUpdating || reviewerOptionRows.length === 0}
                            onChange={(event) => setReviewerDraftId(event.target.value)}
                            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                          >
                            <option value="">Add reviewer</option>
                            {reviewerOptionRows.map((reviewer) => (
                              <option key={gitLabUserKey(reviewer)} value={gitLabUserKey(reviewer)}>
                                {reviewer.username}
                              </option>
                            ))}
                          </select>
                          <Button
                            type="button"
                            size="xs"
                            disabled={!reviewerDraftId || reviewerUpdating}
                            onClick={() => {
                              const reviewer = reviewerOptionRows.find(
                                (user) => gitLabUserKey(user) === reviewerDraftId
                              )
                              if (reviewer) {
                                void handleSetReviewers([...currentReviewers, reviewer])
                              }
                            }}
                          >
                            {reviewerUpdating ? (
                              <LoaderCircle className="size-3 animate-spin" />
                            ) : null}
                            Add
                          </Button>
                        </div>
                      ) : null}
                      {approvalState?.rules.length ? (
                        <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
                          {approvalState.rules.map((rule) => (
                            <div
                              key={rule.id}
                              className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground"
                            >
                              <span className="min-w-0 truncate">{rule.name}</span>
                              <span>
                                {rule.approved ? 'Approved' : `${rule.approvalsRequired} required`}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {loading && !details ? (
                    <div className="flex items-center justify-center py-12">
                      <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : editingDetails ? (
                    <div className="space-y-3">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">
                          Title
                        </label>
                        <input
                          value={titleDraft}
                          onChange={(event) => setTitleDraft(event.target.value)}
                          disabled={detailsSaving}
                          className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">
                          Description
                        </label>
                        <textarea
                          value={bodyDraft}
                          onChange={(event) => setBodyDraft(event.target.value)}
                          rows={8}
                          disabled={detailsSaving}
                          className="min-h-40 w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-sm shadow-xs focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">
                          Labels
                        </label>
                        <input
                          value={labelDraft}
                          onChange={(event) => setLabelDraft(event.target.value)}
                          disabled={detailsSaving}
                          placeholder="bug, backend"
                          className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
                        />
                        {labelOptionsLoading || labelSuggestionOptions.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {labelOptionsLoading ? (
                              <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border/50 px-2 text-[11px] text-muted-foreground">
                                <LoaderCircle className="size-3 animate-spin" />
                                Loading labels
                              </span>
                            ) : null}
                            {labelSuggestionOptions.map((label) => {
                              const selected = parseGitLabLabelDraft(labelDraft).some(
                                (item) => item.toLowerCase() === label.toLowerCase()
                              )
                              return (
                                <button
                                  key={label}
                                  type="button"
                                  disabled={detailsSaving}
                                  onClick={() =>
                                    setLabelDraft(toggleGitLabLabelDraft(labelDraft, label))
                                  }
                                  className={cn(
                                    'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors',
                                    selected
                                      ? 'border-primary/40 bg-primary/10 text-primary'
                                      : 'border-border/50 bg-muted/30 text-muted-foreground hover:bg-muted/60'
                                  )}
                                >
                                  {selected ? <Check className="size-3" /> : null}
                                  {label}
                                </button>
                              )
                            })}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={detailsSaving}
                          onClick={handleCancelDetailsEdit}
                        >
                          <X className="size-3.5" />
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={detailsSaving || !titleDraft.trim()}
                          onClick={() => void handleSaveDetails()}
                        >
                          {detailsSaving ? (
                            <LoaderCircle className="size-3.5 animate-spin" />
                          ) : (
                            <Check className="size-3.5" />
                          )}
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : details?.body ? (
                    <div>
                      {isMR && details ? (
                        <div className="mb-3 flex justify-end">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={handleStartDetailsEdit}
                            className="gap-1.5"
                          >
                            <Pencil className="size-3.5" />
                            Edit
                          </Button>
                        </div>
                      ) : null}
                      <CommentMarkdown content={details.body} />
                    </div>
                  ) : (
                    <div>
                      {isMR && details ? (
                        <div className="mb-3 flex justify-end">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={handleStartDetailsEdit}
                            className="gap-1.5"
                          >
                            <Pencil className="size-3.5" />
                            Edit
                          </Button>
                        </div>
                      ) : null}
                      <p className="text-sm text-muted-foreground">No description.</p>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="conversation" className="mt-0 space-y-3">
                  {loading && !details ? (
                    <div className="flex items-center justify-center py-12">
                      <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : details?.comments?.length ? (
                    details.comments.map((c) => (
                      <CommentCard
                        key={c.id}
                        comment={c}
                        canResolve={isMR}
                        resolving={resolvingThreadId === c.threadId}
                        onResolve={(threadId, resolved) =>
                          void handleResolveDiscussion(threadId, resolved)
                        }
                      />
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">No comments yet.</p>
                  )}
                </TabsContent>

                {isMR ? (
                  <TabsContent value="files" className="mt-0 space-y-3">
                    {loading && !details ? (
                      <div className="flex items-center justify-center py-12">
                        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : details?.files?.length ? (
                      <>
                        <div className="rounded-md border border-border/50 bg-muted/20 p-3">
                          <div className="grid grid-cols-[minmax(0,1fr)_80px] gap-2">
                            <select
                              value={inlineCommentFilePath}
                              onChange={(event) => setInlineCommentFilePath(event.target.value)}
                              className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                            >
                              <option value="">File</option>
                              {details.files.map((file) => (
                                <option key={file.path} value={file.path}>
                                  {file.path}
                                </option>
                              ))}
                            </select>
                            <input
                              value={inlineCommentLine}
                              onChange={(event) => setInlineCommentLine(event.target.value)}
                              inputMode="numeric"
                              placeholder="Line"
                              className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                            />
                          </div>
                          <textarea
                            value={inlineCommentBody}
                            onChange={(event) => setInlineCommentBody(event.target.value)}
                            rows={2}
                            placeholder="Inline comment"
                            className="mt-2 w-full resize-none rounded-md border border-input bg-background px-2.5 py-1.5 text-sm shadow-xs focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
                          />
                          <div className="mt-2 flex justify-end">
                            <Button
                              type="button"
                              size="sm"
                              disabled={
                                inlineCommentSubmitting ||
                                !inlineCommentFilePath ||
                                !inlineCommentLine.trim() ||
                                !inlineCommentBody.trim()
                              }
                              onClick={() => void handleSubmitInlineComment()}
                            >
                              {inlineCommentSubmitting ? (
                                <LoaderCircle className="size-3.5 animate-spin" />
                              ) : (
                                <Send className="size-3.5" />
                              )}
                              Comment
                            </Button>
                          </div>
                        </div>
                        <div className="space-y-2">
                          {details.files.map((file) => (
                            <div
                              key={file.path}
                              className="rounded-md border border-border/50 bg-muted/10"
                            >
                              <div className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-2">
                                <div className="min-w-0">
                                  <div className="break-all font-mono text-xs text-foreground">
                                    {file.path}
                                  </div>
                                  {file.oldPath ? (
                                    <div className="break-all font-mono text-[11px] text-muted-foreground">
                                      from {file.oldPath}
                                    </div>
                                  ) : null}
                                </div>
                                <div className="shrink-0 text-[11px] text-muted-foreground">
                                  <span className="text-emerald-600">+{file.additions}</span>{' '}
                                  <span className="text-rose-600">-{file.deletions}</span>
                                </div>
                              </div>
                              {file.diff ? (
                                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-4 text-foreground scrollbar-sleek">
                                  {file.diff}
                                </pre>
                              ) : (
                                <div className="px-3 py-3 text-xs text-muted-foreground">
                                  Diff content unavailable.
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">No changed files.</p>
                    )}
                  </TabsContent>
                ) : null}

                {isMR ? (
                  <TabsContent value="pipeline" className="mt-0">
                    {loading && !details ? (
                      <div className="flex items-center justify-center py-12">
                        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : details?.pipelineJobs?.length ? (
                      <div className="space-y-1">
                        {details.pipelineJobs.map((j) => (
                          <PipelineJobRow
                            key={j.id}
                            job={j}
                            expanded={expandedJobId === j.id}
                            traceState={jobTraceById[j.id]}
                            retrying={retryingJobId === j.id}
                            onToggleTrace={(job) => void handleToggleJobTrace(job)}
                            onRetry={(job) => void handleRetryJob(job)}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No pipeline runs for this MR.</p>
                    )}
                  </TabsContent>
                ) : null}
              </div>
            </Tabs>

            <footer className="flex-none space-y-3 border-t border-border/40 px-5 py-3">
              {/* Why: comment composer at the top of the footer so the
                  primary actions row stays visually grouped at the bottom. */}
              <div className="flex items-end gap-2">
                <textarea
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  placeholder={`Comment on ${prefix}${item.number}…`}
                  rows={2}
                  disabled={commentSubmitting}
                  className="min-h-9 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm shadow-xs focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
                  onKeyDown={(e) => {
                    // Why: this is local textarea submit behavior; Settings
                    // keybindings only cover app commands.
                    if (isScreenSubmitShortcut(e) && commentDraft.trim() && !commentSubmitting) {
                      e.preventDefault()
                      void handleSubmitComment()
                    }
                  }}
                />
                <Button
                  size="sm"
                  disabled={!commentDraft.trim() || commentSubmitting}
                  onClick={() => void handleSubmitComment()}
                  className="shrink-0 gap-1.5"
                >
                  {commentSubmitting ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Send className="size-3.5" />
                  )}
                  Comment
                </Button>
              </div>

              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void window.api.shell.openUrl(item.url)}
                  className="gap-1.5"
                >
                  <ExternalLink className="size-3.5" />
                  Open in GitLab
                </Button>
                <div className="flex items-center gap-2">
                  {onCreateWorkspace ? (
                    <Button variant="outline" size="sm" onClick={() => onCreateWorkspace(item)}>
                      Create workspace
                    </Button>
                  ) : null}
                  {canMerge ? (
                    <Button
                      size="sm"
                      disabled={actionInFlight !== null}
                      onClick={() => void handleMerge()}
                    >
                      {actionInFlight === 'merge' ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : null}
                      Merge
                    </Button>
                  ) : null}
                  {canClose ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actionInFlight !== null}
                      onClick={() => void handleClose()}
                    >
                      {actionInFlight === 'close' ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : null}
                      Close
                    </Button>
                  ) : null}
                  {canReopen ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actionInFlight !== null}
                      onClick={() => void handleReopen()}
                    >
                      {actionInFlight === 'reopen' ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : null}
                      Reopen
                    </Button>
                  ) : null}
                </div>
              </div>
            </footer>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
