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
import { CircleDot, ExternalLink, GitMerge, LoaderCircle, RefreshCw, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VisuallyHidden } from 'radix-ui'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import type {
  GitLabPipelineJob,
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

function CommentCard({ comment }: { comment: MRComment }): React.JSX.Element {
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
        <span>{comment.createdAt ? new Date(comment.createdAt).toLocaleDateString() : ''}</span>
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

function PipelineJobRow({ job }: { job: GitLabPipelineJob }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => job.webUrl && void window.api.shell.openUrl(job.webUrl)}
      className="grid w-full grid-cols-[minmax(0,2fr)_minmax(0,1fr)_80px_60px] items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/40"
    >
      <span className="min-w-0 truncate font-medium">{job.name}</span>
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
    </button>
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
  const [actionInFlight, setActionInFlight] = useState<'close' | 'reopen' | 'merge' | null>(null)

  useEffect(() => {
    if (!item || !repoPath) {
      setDetails(null)
      setLoading(false)
      setError(null)
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
  }, [item?.id])

  const handleRefresh = useCallback(() => {
    setRefreshNonce((n) => n + 1)
  }, [])

  const handleClose = useCallback(async (): Promise<void> => {
    if (!item || !repoPath || item.type !== 'mr') {
      return
    }
    setActionInFlight('close')
    try {
      const res = await window.api.gl.closeMR({ repoPath, iid: item.number })
      if (res.ok) {
        toast.success(`Closed MR !${item.number}`)
        handleRefresh()
      } else {
        toast.error(res.error)
      }
    } finally {
      setActionInFlight(null)
    }
  }, [item, repoPath, handleRefresh])

  const handleReopen = useCallback(async (): Promise<void> => {
    if (!item || !repoPath || item.type !== 'mr') {
      return
    }
    setActionInFlight('reopen')
    try {
      const res = await window.api.gl.reopenMR({ repoPath, iid: item.number })
      if (res.ok) {
        toast.success(`Reopened MR !${item.number}`)
        handleRefresh()
      } else {
        toast.error(res.error)
      }
    } finally {
      setActionInFlight(null)
    }
  }, [item, repoPath, handleRefresh])

  const handleMerge = useCallback(async (): Promise<void> => {
    if (!item || !repoPath || item.type !== 'mr') {
      return
    }
    setActionInFlight('merge')
    try {
      const res = await window.api.gl.mergeMR({ repoPath, iid: item.number })
      if (res.ok) {
        toast.success(`Merged MR !${item.number}`)
        handleRefresh()
      } else {
        toast.error(res.error)
      }
    } finally {
      setActionInFlight(null)
    }
  }, [item, repoPath, handleRefresh])

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
        setCommentDraft('')
        handleRefresh()
      } else {
        toast.error(res.error)
      }
    } finally {
      setCommentSubmitting(false)
    }
  }, [commentDraft, item, repoPath, handleRefresh])

  // Why: GitMerge for MRs visually disambiguates from GitBranch (and
  // matches gitlab.com's MR iconography); CircleDot stays on issues.
  const Icon = item?.type === 'mr' ? GitMerge : CircleDot
  const prefix = item?.type === 'mr' ? '!' : '#'
  const isMR = item?.type === 'mr'
  const canClose = isMR && item?.state === 'opened'
  const canReopen = isMR && item?.state === 'closed'
  const canMerge = isMR && item?.state === 'opened'

  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <VisuallyHidden.Root>
          <SheetTitle>{item ? item.title : 'Work item'}</SheetTitle>
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
                    {item.title}
                  </h2>
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
                  {loading && !details ? (
                    <div className="flex items-center justify-center py-12">
                      <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : details?.body ? (
                    <CommentMarkdown content={details.body} />
                  ) : (
                    <p className="text-sm text-muted-foreground">No description.</p>
                  )}
                </TabsContent>

                <TabsContent value="conversation" className="mt-0 space-y-3">
                  {loading && !details ? (
                    <div className="flex items-center justify-center py-12">
                      <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : details?.comments?.length ? (
                    details.comments.map((c) => <CommentCard key={c.id} comment={c} />)
                  ) : (
                    <p className="text-sm text-muted-foreground">No comments yet.</p>
                  )}
                </TabsContent>

                {isMR ? (
                  <TabsContent value="pipeline" className="mt-0">
                    {loading && !details ? (
                      <div className="flex items-center justify-center py-12">
                        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : details?.pipelineJobs?.length ? (
                      <div className="space-y-1">
                        {details.pipelineJobs.map((j) => (
                          <PipelineJobRow key={j.id} job={j} />
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
                    // Why: Cmd/Ctrl+Enter sends — matches gitlab.com's
                    // textarea behavior so users coming from the web UI
                    // get a familiar shortcut.
                    if (
                      e.key === 'Enter' &&
                      (e.metaKey || e.ctrlKey) &&
                      commentDraft.trim() &&
                      !commentSubmitting
                    ) {
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
                  Open in browser
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
