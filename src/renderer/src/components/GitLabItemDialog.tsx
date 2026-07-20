/* eslint-disable max-lines -- Why: dialog co-locates header, three
   tabs (Description / Conversation / Pipeline), comment composer,
   and four mutation actions. Splitting any of these into separate
   components would make the close/reopen/merge state coupling
   non-obvious. The GitHub-side equivalent (GitHubItemDialog) carries
   the same disable for the same reason. */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: GitLab item dialogs reset draft/provider state and hydrate details from GitLab IPC when the selected item identity changes. */
/* Why: GitLab counterpart to GitHubItemDialog. Side sheet with three
   tabs (Description / Conversation / Pipeline) and footer actions —
   close/reopen, merge, and a top-level comment composer. Files /
   inline review-comment positioning / approvals are deferred to v1.5
   since they mirror substantial GitHub-side surface area. */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
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
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import { useAppStore } from '@/store'
import type {
  GitLabAssignableUser,
  GitLabPipelineJob,
  GitLabMRUpdate,
  GitLabWorkItem,
  GitLabWorkItemDetails,
  MRComment
} from '../../../shared/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'

type Props = {
  item: GitLabWorkItem | null
  repoPath: string | null
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  onClose: () => void
  onCreateWorkspace?: (item: GitLabWorkItem) => void
}

type GitLabDialogRepoSelector = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
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
              {translate('auto.components.GitLabItemDialog.f23ea85341', 'resolved')}
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
              {comment.isResolved
                ? translate('auto.components.GitLabItemDialog.65e784c1f1', 'Reopen')
                : translate('auto.components.GitLabItemDialog.4168eb2c51', 'Resolve')}
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
              {translate('auto.components.GitLabItemDialog.fa3e042203', 'Retry')}
            </Button>
          ) : null}
          {job.webUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void window.api.shell.openUrl(job.webUrl)}
              title={translate('auto.components.GitLabItemDialog.032ae1312b', 'Open job in GitLab')}
            >
              <ExternalLink className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <div className="mx-3 mb-2 rounded-md border border-border/50 bg-muted/20">
          <div className="flex items-center justify-between border-b border-border/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <span>{translate('auto.components.GitLabItemDialog.2f9b27f838', 'Job log')}</span>
            <Button type="button" variant="ghost" size="xs" onClick={() => onToggleTrace(job)}>
              {translate('auto.components.GitLabItemDialog.028bde664e', 'Hide')}
            </Button>
          </div>
          {traceState?.loading ? (
            <div className="flex items-center gap-2 px-2.5 py-3 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />
              {translate('auto.components.GitLabItemDialog.d600c2619a', 'Loading log')}
            </div>
          ) : traceState?.error ? (
            <div className="px-2.5 py-3 text-xs text-destructive">{traceState.error}</div>
          ) : (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-4 text-foreground scrollbar-sleek">
              {traceState?.trace?.trim()
                ? traceState.trace
                : translate('auto.components.GitLabItemDialog.32f8bef818', 'No log output.')}
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
  repoId,
  sourceContext,
  onClose,
  onCreateWorkspace
}: Props): React.JSX.Element {
  const [details, setDetails] = useState<GitLabWorkItemDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const itemId = item?.id ?? null
  const [commentDraftState, setCommentDraftState] = useState<{
    itemId: string | null
    value: string
  }>(() => ({ itemId, value: '' }))
  const commentDraft = commentDraftState.itemId === itemId ? commentDraftState.value : ''
  if (commentDraftState.itemId !== itemId) {
    // Why: comment drafts are tied to one GitLab item, so switching the sheet
    // target must not leave a draft that could post to the wrong MR/issue.
    setCommentDraftState({ itemId, value: '' })
  }
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
  const repoSelector = useMemo<GitLabDialogRepoSelector | null>(() => {
    if (!repoPath) {
      return null
    }
    return {
      repoPath,
      ...(repoId ? { repoId } : {}),
      ...(sourceContext ? { sourceContext } : {})
    }
  }, [repoId, repoPath, sourceContext])
  const updateCommentDraft = useCallback(
    (value: string): void => {
      setCommentDraftState({ itemId, value })
    },
    [itemId]
  )

  useEffect(() => {
    if (!item || !repoSelector) {
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
      .workItemDetails({ ...repoSelector, iid: item.number, type: item.type })
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
  }, [item, repoSelector, refreshNonce])

  // Why: clear item-scoped dialog state when the sheet target changes. The
  // top-level comment draft is reconciled during render so it cannot flash stale.
  useEffect(() => {
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
    if (!repoSelector || labelOptions !== null || labelOptionsLoading) {
      return
    }
    setLabelOptionsLoading(true)
    try {
      const labels = await window.api.gl.listLabels(repoSelector)
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
  }, [labelOptions, labelOptionsLoading, mountedRef, repoSelector])

  const loadGitLabReviewerOptions = useCallback(async (): Promise<void> => {
    if (!repoSelector || reviewerOptions !== null || reviewerOptionsLoading) {
      return
    }
    setReviewerOptionsLoading(true)
    try {
      const users = await window.api.gl.listAssignableUsers(repoSelector)
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
  }, [mountedRef, repoSelector, reviewerOptions, reviewerOptionsLoading])

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
    if (!item || !details || !repoSelector || item.type !== 'mr') {
      return
    }
    const currentTitle = details.item.title || item.title
    const currentBody = details.body
    const currentLabels = normalizeGitLabLabels(details.item.labels ?? item.labels)
    const nextTitle = titleDraft.trim()
    const nextBody = bodyDraft
    const nextLabels = parseGitLabLabelDraft(labelDraft)
    if (!nextTitle) {
      toast.error(translate('auto.components.GitLabItemDialog.98718490e4', 'MR title is required.'))
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
      const res = await window.api.gl.updateMR({ ...repoSelector, iid: item.number, updates })
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
          useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
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
    repoSelector,
    titleDraft
  ])

  const handleToggleJobTrace = useCallback(
    async (job: GitLabPipelineJob): Promise<void> => {
      if (expandedJobId === job.id) {
        setExpandedJobId(null)
        return
      }
      setExpandedJobId(job.id)
      if (!repoSelector || !item || jobTraceById[job.id]?.trace || jobTraceById[job.id]?.error) {
        return
      }
      setJobTraceById((current) => ({
        ...current,
        [job.id]: { loading: true }
      }))
      try {
        const result = await window.api.gl.jobTrace({
          ...repoSelector,
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
    [details?.item.projectRef, expandedJobId, item, jobTraceById, mountedRef, repoSelector]
  )

  const handleRetryJob = useCallback(
    async (job: GitLabPipelineJob): Promise<void> => {
      if (!repoSelector || !item) {
        return
      }
      setRetryingJobId(job.id)
      try {
        const result = await window.api.gl.retryJob({
          ...repoSelector,
          jobId: job.id,
          projectRef: details?.item.projectRef ?? item.projectRef ?? null
        })
        if (!mountedRef.current) {
          return
        }
        if (result.ok) {
          toast.success(
            translate('auto.components.GitLabItemDialog.f7cb495a12', 'Retried {{value0}}', {
              value0: job.name
            })
          )
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
    [details?.item.projectRef, handleRefresh, item, mountedRef, repoSelector]
  )

  const handleSetReviewers = useCallback(
    async (nextReviewers: GitLabAssignableUser[]): Promise<void> => {
      if (!repoSelector || !item || !details || item.type !== 'mr') {
        return
      }
      const reviewerIds = nextReviewers
        .map((reviewer) => reviewer.id)
        .filter((id): id is number => typeof id === 'number')
      if (reviewerIds.length !== nextReviewers.length) {
        toast.error(
          translate(
            'auto.components.GitLabItemDialog.ceaf7c30c7',
            'Reviewer id is unavailable for this GitLab user.'
          )
        )
        return
      }
      setReviewerUpdating(true)
      try {
        const result = await window.api.gl.updateMRReviewers({
          ...repoSelector,
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
          useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
        } else {
          toast.error(result.error)
        }
      } finally {
        if (mountedRef.current) {
          setReviewerUpdating(false)
        }
      }
    },
    [details, item, mountedRef, repoSelector]
  )

  const handleSubmitInlineComment = useCallback(async (): Promise<void> => {
    if (!repoSelector || !item || !details || item.type !== 'mr') {
      return
    }
    const file = (details.files ?? []).find((row) => row.path === inlineCommentFilePath)
    const line = Number.parseInt(inlineCommentLine, 10)
    const bodyState = getCommentBodySubmitState(inlineCommentBody)
    if (!file || !Number.isFinite(line) || line <= 0 || bodyState.status === 'empty') {
      toast.error(
        translate(
          'auto.components.GitLabItemDialog.00d0d25825',
          'File, line, and comment are required.'
        )
      )
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate(
          'auto.components.GitLabItemDialog.commentTooLarge',
          'Comment is too large to submit safely.'
        )
      )
      return
    }
    if (!details.baseSha || !details.startSha || !details.headSha) {
      toast.error(
        translate(
          'auto.components.GitLabItemDialog.ffdd9a78e1',
          'MR diff refs are unavailable for inline comments.'
        )
      )
      return
    }
    setInlineCommentSubmitting(true)
    try {
      const result = await window.api.gl.addMRInlineComment({
        ...repoSelector,
        iid: item.number,
        projectRef: details.item.projectRef ?? item.projectRef ?? null,
        input: {
          body: bodyState.body,
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
        useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
        toast.success(
          translate('auto.components.GitLabItemDialog.60c13320c4', 'Inline comment added')
        )
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
    repoSelector
  ])

  const handleClose = useCallback(async (): Promise<void> => {
    if (!item || !repoSelector || item.type !== 'mr') {
      return
    }
    setActionInFlight('close')
    try {
      const res = await window.api.gl.closeMR({ ...repoSelector, iid: item.number })
      if (res.ok) {
        if (mountedRef.current) {
          useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
          toast.success(
            translate('auto.components.GitLabItemDialog.9b11cd233f', 'Closed MR !{{value0}}', {
              value0: item.number
            })
          )
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
  }, [item, repoSelector, mountedRef, handleRefresh])

  const handleReopen = useCallback(async (): Promise<void> => {
    if (!item || !repoSelector || item.type !== 'mr') {
      return
    }
    setActionInFlight('reopen')
    try {
      const res = await window.api.gl.reopenMR({ ...repoSelector, iid: item.number })
      if (res.ok) {
        if (mountedRef.current) {
          useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
          toast.success(
            translate('auto.components.GitLabItemDialog.865ea2703e', 'Reopened MR !{{value0}}', {
              value0: item.number
            })
          )
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
  }, [item, repoSelector, mountedRef, handleRefresh])

  const handleMerge = useCallback(async (): Promise<void> => {
    if (!item || !repoSelector || item.type !== 'mr') {
      return
    }
    setActionInFlight('merge')
    try {
      const res = await window.api.gl.mergeMR({ ...repoSelector, iid: item.number })
      if (res.ok) {
        if (mountedRef.current) {
          useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
          toast.success(
            translate('auto.components.GitLabItemDialog.e089f62594', 'Merged MR !{{value0}}', {
              value0: item.number
            })
          )
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
  }, [item, repoSelector, mountedRef, handleRefresh])

  const handleSubmitComment = useCallback(async (): Promise<void> => {
    const bodyState = getCommentBodySubmitState(commentDraft)
    if (bodyState.status === 'empty' || !item || !repoSelector) {
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate(
          'auto.components.GitLabItemDialog.commentTooLarge',
          'Comment is too large to submit safely.'
        )
      )
      return
    }
    setCommentSubmitting(true)
    try {
      // Why: the IPC for issue comments takes `number`, MR takes `iid`.
      // Branch on the item type to hit the right channel.
      const res =
        item.type === 'mr'
          ? await window.api.gl.addMRComment({
              ...repoSelector,
              iid: item.number,
              body: bodyState.body
            })
          : await window.api.gl.addIssueComment({
              ...repoSelector,
              number: item.number,
              body: bodyState.body
            })
      if (res.ok) {
        if (mountedRef.current) {
          setCommentDraftState((current) =>
            current.itemId === itemId ? { itemId, value: '' } : current
          )
          useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
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
  }, [commentDraft, item, itemId, repoSelector, mountedRef, handleRefresh])
  const canSubmitInlineComment = hasBoundedCommentBodyText(inlineCommentBody)
  const canSubmitComment = hasBoundedCommentBodyText(commentDraft)

  const handleResolveDiscussion = useCallback(
    async (threadId: string, resolved: boolean): Promise<void> => {
      if (!item || !repoSelector || item.type !== 'mr') {
        return
      }
      setResolvingThreadId(threadId)
      try {
        const res = await window.api.gl.resolveMRDiscussion({
          ...repoSelector,
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
            useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
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
    [item, repoSelector, mountedRef]
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
          <SheetTitle>
            {item
              ? visibleTitle
              : translate('auto.components.GitLabItemDialog.3a051b8ade', 'Work item')}
          </SheetTitle>
          <SheetDescription>
            {translate('auto.components.GitLabItemDialog.30c97083c2', 'GitLab work item detail')}
          </SheetDescription>
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
                    {item.author ? (
                      <span>
                        {translate('auto.components.GitLabItemDialog.9bfb4a24d7', 'by')}{' '}
                        {item.author}
                      </span>
                    ) : null}
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
                  aria-label={translate('auto.components.GitLabItemDialog.b3c156dd51', 'Refresh')}
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
                <TabsTrigger value="description">
                  {translate('auto.components.GitLabItemDialog.908d8d2a73', 'Description')}
                </TabsTrigger>
                <TabsTrigger value="conversation">
                  {translate('auto.components.GitLabItemDialog.c996e2962c', 'Conversation')}
                  {details?.comments?.length ? (
                    <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] font-medium">
                      {details.comments.length}
                    </span>
                  ) : null}
                </TabsTrigger>
                {isMR ? (
                  <TabsTrigger value="files">
                    {translate('auto.components.GitLabItemDialog.be3d291837', 'Files')}
                    {details?.files?.length ? (
                      <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] font-medium">
                        {details.files.length}
                      </span>
                    ) : null}
                  </TabsTrigger>
                ) : null}
                {isMR ? (
                  <TabsTrigger value="pipeline">
                    {translate('auto.components.GitLabItemDialog.02cbe2de44', 'Pipeline')}
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
                          <div className="text-xs font-medium text-foreground">
                            {translate('auto.components.GitLabItemDialog.4f9313984d', 'Reviewers')}
                          </div>
                          {approvalState ? (
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              {approvalState.approvalsLeft === 0
                                ? translate(
                                    'auto.components.GitLabItemDialog.22511537d2',
                                    'Approved'
                                  )
                                : translate(
                                    'auto.components.GitLabItemDialog.40c56b95e2',
                                    '{{value0}} approval{{value1}} remaining',
                                    {
                                      value0: approvalState.approvalsLeft ?? 0,
                                      value1: approvalState.approvalsLeft === 1 ? '' : 's'
                                    }
                                  )}
                              {typeof approvalState.approvalsRequired === 'number'
                                ? translate(
                                    'auto.components.GitLabItemDialog.00f3bab87b',
                                    ' of {{value0}} required',
                                    { value0: approvalState.approvalsRequired }
                                  )
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
                          {translate('auto.components.GitLabItemDialog.cb55b0390f', 'Manage')}
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
                                aria-label={translate(
                                  'auto.components.GitLabItemDialog.1b19cdc510',
                                  'Remove reviewer {{value0}}',
                                  { value0: reviewer.username }
                                )}
                              >
                                <X className="size-3" />
                              </button>
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] text-muted-foreground">
                            {translate(
                              'auto.components.GitLabItemDialog.474b50d988',
                              'No reviewers.'
                            )}
                          </span>
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
                            <option value="">
                              {translate(
                                'auto.components.GitLabItemDialog.05939e977d',
                                'Add reviewer'
                              )}
                            </option>
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
                            {translate('auto.components.GitLabItemDialog.7a2117129a', 'Add')}
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
                                {rule.approved
                                  ? translate(
                                      'auto.components.GitLabItemDialog.22511537d2',
                                      'Approved'
                                    )
                                  : translate(
                                      'auto.components.GitLabItemDialog.6de8ce0cc6',
                                      '{{value0}} required',
                                      { value0: rule.approvalsRequired }
                                    )}
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
                          {translate('auto.components.GitLabItemDialog.89f3f19368', 'Title')}
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
                          {translate('auto.components.GitLabItemDialog.908d8d2a73', 'Description')}
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
                          {translate('auto.components.GitLabItemDialog.dde24ade55', 'Labels')}
                        </label>
                        <input
                          value={labelDraft}
                          onChange={(event) => setLabelDraft(event.target.value)}
                          disabled={detailsSaving}
                          placeholder={translate(
                            'auto.components.GitLabItemDialog.3c0b6ccca7',
                            'bug, backend'
                          )}
                          className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
                        />
                        {labelOptionsLoading || labelSuggestionOptions.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {labelOptionsLoading ? (
                              <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border/50 px-2 text-[11px] text-muted-foreground">
                                <LoaderCircle className="size-3 animate-spin" />
                                {translate(
                                  'auto.components.GitLabItemDialog.717b706849',
                                  'Loading labels'
                                )}
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
                          {translate('auto.components.GitLabItemDialog.f72fad3b16', 'Cancel')}
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
                          {translate('auto.components.GitLabItemDialog.93f79a3fc1', 'Save')}
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
                            {translate('auto.components.GitLabItemDialog.da4174b00f', 'Edit')}
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
                            {translate('auto.components.GitLabItemDialog.da4174b00f', 'Edit')}
                          </Button>
                        </div>
                      ) : null}
                      <p className="text-sm text-muted-foreground">
                        {translate(
                          'auto.components.GitLabItemDialog.14423484db',
                          'No description.'
                        )}
                      </p>
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
                    <p className="text-sm text-muted-foreground">
                      {translate('auto.components.GitLabItemDialog.85a8170279', 'No comments yet.')}
                    </p>
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
                              <option value="">
                                {translate('auto.components.GitLabItemDialog.ceb08a733d', 'File')}
                              </option>
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
                              placeholder={translate(
                                'auto.components.GitLabItemDialog.7a7204417f',
                                'Line'
                              )}
                              className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                            />
                          </div>
                          <textarea
                            value={inlineCommentBody}
                            onChange={(event) => setInlineCommentBody(event.target.value)}
                            rows={2}
                            placeholder={translate(
                              'auto.components.GitLabItemDialog.21f8dde18a',
                              'Inline comment'
                            )}
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
                                !canSubmitInlineComment
                              }
                              onClick={() => void handleSubmitInlineComment()}
                            >
                              {inlineCommentSubmitting ? (
                                <LoaderCircle className="size-3.5 animate-spin" />
                              ) : (
                                <Send className="size-3.5" />
                              )}
                              {translate('auto.components.GitLabItemDialog.84012fa8fb', 'Comment')}
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
                                      {translate(
                                        'auto.components.GitLabItemDialog.a7eb4f4916',
                                        'from'
                                      )}{' '}
                                      {file.oldPath}
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
                                  {translate(
                                    'auto.components.GitLabItemDialog.007423f585',
                                    'Diff content unavailable.'
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {translate(
                          'auto.components.GitLabItemDialog.808b1ca1ba',
                          'No changed files.'
                        )}
                      </p>
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
                      <p className="text-sm text-muted-foreground">
                        {translate(
                          'auto.components.GitLabItemDialog.f11e3e7675',
                          'No pipeline runs for this MR.'
                        )}
                      </p>
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
                  onChange={(e) => updateCommentDraft(e.target.value)}
                  placeholder={translate(
                    'auto.components.GitLabItemDialog.c08e1d5a57',
                    'Comment on {{value0}}{{value1}}…',
                    { value0: prefix, value1: item.number }
                  )}
                  rows={2}
                  disabled={commentSubmitting}
                  className="min-h-9 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm shadow-xs focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
                  onKeyDown={(e) => {
                    // Why: this is local textarea submit behavior; Settings
                    // keybindings only cover app commands.
                    if (isScreenSubmitShortcut(e) && canSubmitComment && !commentSubmitting) {
                      e.preventDefault()
                      void handleSubmitComment()
                    }
                  }}
                />
                <Button
                  size="sm"
                  disabled={!canSubmitComment || commentSubmitting}
                  onClick={() => void handleSubmitComment()}
                  className="shrink-0 gap-1.5"
                >
                  {commentSubmitting ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Send className="size-3.5" />
                  )}
                  {translate('auto.components.GitLabItemDialog.84012fa8fb', 'Comment')}
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
                  {translate('auto.components.GitLabItemDialog.f2e64d1c20', 'Open in GitLab')}
                </Button>
                <div className="flex items-center gap-2">
                  {onCreateWorkspace ? (
                    <Button variant="outline" size="sm" onClick={() => onCreateWorkspace(item)}>
                      {translate('auto.components.GitLabItemDialog.131865e231', 'Create workspace')}
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
                      {translate('auto.components.GitLabItemDialog.16b3412570', 'Merge')}
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
                      {translate('auto.components.GitLabItemDialog.a199eb364b', 'Close')}
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
                      {translate('auto.components.GitLabItemDialog.65e784c1f1', 'Reopen')}
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
