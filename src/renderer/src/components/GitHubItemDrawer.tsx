/* eslint-disable max-lines -- Why: the GH drawer keeps its header, conversation, files, and checks tabs co-located so the read-only PR/Issue surface stays in one place while this view evolves. */
import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleDot,
  ExternalLink,
  FileText,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { VisuallyHidden } from 'radix-ui'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { detectLanguage } from '@/lib/language-detect'
import { cn } from '@/lib/utils'
import { CHECK_COLOR, CHECK_ICON } from '@/components/right-sidebar/checks-helpers'
import type {
  GitHubPRFile,
  GitHubPRFileContents,
  GitHubWorkItem,
  GitHubWorkItemDetails,
  PRComment
} from '../../../shared/types'

// Why: the editor's DiffViewer loads Monaco, which is heavy and should not be
// pulled into the drawer's bundle until the user actually opens the Files tab.
const DiffViewer = lazy(() => import('@/components/editor/DiffViewer'))

type DrawerTab = 'conversation' | 'files' | 'checks'

type GitHubItemDrawerProps = {
  workItem: GitHubWorkItem | null
  repoPath: string | null
  /** Called when the user clicks the primary CTA — same semantics as today's row-click → composer modal. */
  onUse: (item: GitHubWorkItem) => void
  onClose: () => void
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

function getStateLabel(item: GitHubWorkItem): string {
  if (item.type === 'pr') {
    if (item.state === 'merged') {
      return 'Merged'
    }
    if (item.state === 'draft') {
      return 'Draft'
    }
    if (item.state === 'closed') {
      return 'Closed'
    }
    return 'Open'
  }
  return item.state === 'closed' ? 'Closed' : 'Open'
}

function getStateTone(item: GitHubWorkItem): string {
  if (item.type === 'pr') {
    if (item.state === 'merged') {
      return 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-300'
    }
    if (item.state === 'draft') {
      return 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300'
    }
    if (item.state === 'closed') {
      return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
    }
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
  }
  if (item.state === 'closed') {
    return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
  }
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
}

function fileStatusTone(status: GitHubPRFile['status']): string {
  switch (status) {
    case 'added':
      return 'text-emerald-500'
    case 'removed':
      return 'text-rose-500'
    case 'renamed':
    case 'copied':
      return 'text-sky-500'
    default:
      return 'text-amber-500'
  }
}

function fileStatusLabel(status: GitHubPRFile['status']): string {
  switch (status) {
    case 'added':
      return 'A'
    case 'removed':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    case 'unchanged':
      return '·'
    default:
      return 'M'
  }
}

type FileRowProps = {
  file: GitHubPRFile
  repoPath: string
  prNumber: number
  headSha: string | undefined
  baseSha: string | undefined
}

function PRFileRow({
  file,
  repoPath,
  prNumber,
  headSha,
  baseSha
}: FileRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [contents, setContents] = useState<GitHubPRFileContents | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canLoadDiff = Boolean(headSha && baseSha) && !file.isBinary

  const handleToggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev
      if (next && !contents && !loading && canLoadDiff && headSha && baseSha) {
        setLoading(true)
        setError(null)
        window.api.gh
          .prFileContents({
            repoPath,
            prNumber,
            path: file.path,
            oldPath: file.oldPath,
            status: file.status,
            headSha,
            baseSha
          })
          .then((result) => {
            setContents(result)
          })
          .catch((err) => {
            setError(err instanceof Error ? err.message : 'Failed to load diff')
          })
          .finally(() => {
            setLoading(false)
          })
      }
      return next
    })
  }, [
    baseSha,
    canLoadDiff,
    contents,
    file.oldPath,
    file.path,
    file.status,
    headSha,
    loading,
    prNumber,
    repoPath
  ])

  const language = useMemo(() => detectLanguage(file.path), [file.path])
  const modelKey = `gh-drawer:pr:${prNumber}:${file.path}`

  return (
    <div className="border-b border-border/50">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-muted/40"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            'inline-flex size-5 shrink-0 items-center justify-center rounded border border-border/60 font-mono text-[10px]',
            fileStatusTone(file.status)
          )}
          aria-label={file.status}
        >
          {fileStatusLabel(file.status)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
          {file.oldPath && file.oldPath !== file.path ? (
            <>
              <span className="text-muted-foreground">{file.oldPath}</span>
              <span className="mx-1 text-muted-foreground">→</span>
              {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          <span className="text-emerald-500">+{file.additions}</span>
          <span className="mx-1">/</span>
          <span className="text-rose-500">−{file.deletions}</span>
        </span>
      </button>

      {expanded && (
        // Why: DiffViewer's inner layout uses flex-1/min-h-0, so this wrapper
        // must be a flex column with a fixed height for Monaco to size itself
        // correctly. A plain block div collapses flex-1 to 0 and renders empty.
        <div className="flex h-[420px] flex-col border-t border-border/40 bg-background">
          {!canLoadDiff ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-muted-foreground">
              {file.isBinary
                ? 'Binary file — diff not shown.'
                : 'Diff unavailable (missing commit SHAs).'}
            </div>
          ) : loading ? (
            <div className="flex h-full items-center justify-center">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-destructive">
              {error}
            </div>
          ) : contents ? (
            contents.originalIsBinary || contents.modifiedIsBinary ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-muted-foreground">
                Binary file — diff not shown.
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                  </div>
                }
              >
                <DiffViewer
                  modelKey={modelKey}
                  originalContent={contents.original}
                  modifiedContent={contents.modified}
                  language={language}
                  filePath={file.path}
                  relativePath={file.path}
                  sideBySide={false}
                />
              </Suspense>
            )
          ) : null}
        </div>
      )}
    </div>
  )
}

function ConversationTab({
  item,
  body,
  comments,
  loading
}: {
  item: GitHubWorkItem
  body: string
  comments: PRComment[]
  loading: boolean
}): React.JSX.Element {
  const authorLabel = item.author ?? 'unknown'
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="rounded-lg border border-border/50 bg-background/40">
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-[12px] text-muted-foreground">
          <span className="font-medium text-foreground">{authorLabel}</span>
          <span>· {formatRelativeTime(item.updatedAt)}</span>
        </div>
        <div className="px-3 py-3 text-[14px] leading-relaxed text-foreground">
          {body.trim() ? (
            <CommentMarkdown content={body} className="text-[14px] leading-relaxed" />
          ) : (
            <span className="italic text-muted-foreground">No description provided.</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <MessageSquare className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-medium text-foreground">Comments</span>
        {comments.length > 0 && (
          <span className="text-[12px] text-muted-foreground">{comments.length}</span>
        )}
      </div>

      {loading && comments.length === 0 ? (
        <div className="flex items-center justify-center py-6">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : comments.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No comments yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {comments.map((comment) => (
            <div key={comment.id} className="rounded-lg border border-border/40 bg-background/30">
              <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
                {comment.authorAvatarUrl ? (
                  <img
                    src={comment.authorAvatarUrl}
                    alt={comment.author}
                    className="size-5 shrink-0 rounded-full"
                  />
                ) : (
                  <div className="size-5 shrink-0 rounded-full bg-muted" />
                )}
                <span className="text-[13px] font-semibold text-foreground">{comment.author}</span>
                <span className="text-[12px] text-muted-foreground">
                  · {formatRelativeTime(comment.createdAt)}
                </span>
                {comment.path && (
                  <span className="font-mono text-[11px] text-muted-foreground/70">
                    {comment.path.split('/').pop()}
                    {comment.line ? `:L${comment.line}` : ''}
                  </span>
                )}
                {comment.isResolved && (
                  <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    resolved
                  </span>
                )}
                <div className="ml-auto">
                  {comment.url && (
                    <button
                      type="button"
                      onClick={() => window.api.shell.openUrl(comment.url)}
                      className="text-muted-foreground/60 hover:text-foreground"
                      aria-label="Open comment on GitHub"
                    >
                      <ExternalLink className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="px-3 py-2">
                <CommentMarkdown content={comment.body} className="text-[13px] leading-relaxed" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ChecksTab({
  checks,
  loading
}: {
  checks: GitHubWorkItemDetails['checks']
  loading: boolean
}): React.JSX.Element {
  const list = checks ?? []
  if (loading && list.length === 0) {
    return (
      <div className="flex items-center justify-center py-10">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (list.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
        No checks configured.
      </div>
    )
  }
  return (
    <div className="px-2 py-2">
      {list.map((check) => {
        const conclusion = check.conclusion ?? 'pending'
        const Icon = CHECK_ICON[conclusion] ?? CircleDashed
        const color = CHECK_COLOR[conclusion] ?? 'text-muted-foreground'
        return (
          <button
            key={check.name}
            type="button"
            onClick={() => {
              if (check.url) {
                window.api.shell.openUrl(check.url)
              }
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition',
              check.url ? 'hover:bg-muted/40' : ''
            )}
          >
            <Icon
              className={cn('size-3.5 shrink-0', color, conclusion === 'pending' && 'animate-spin')}
            />
            <span className="flex-1 truncate text-[12px] text-foreground">{check.name}</span>
            {check.url && <ExternalLink className="size-3 shrink-0 text-muted-foreground/40" />}
          </button>
        )
      })}
    </div>
  )
}

export default function GitHubItemDrawer({
  workItem,
  repoPath,
  onUse,
  onClose
}: GitHubItemDrawerProps): React.JSX.Element {
  const [tab, setTab] = useState<DrawerTab>('conversation')
  const [details, setDetails] = useState<GitHubWorkItemDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const requestIdRef = useRef(0)

  // Why: when this drawer opens immediately after another Radix overlay
  // (e.g. the New Issue dialog) closed, Radix may leave `pointer-events: none`
  // on <body>. That silently kills clicks on the header's Close/open-in-GitHub
  // buttons. Poll a few frames to clear it whenever Radix re-applies it during
  // its own mount sequence.
  useEffect(() => {
    if (!workItem) {
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
  }, [workItem])

  useEffect(() => {
    if (!workItem || !repoPath) {
      setDetails(null)
      setError(null)
      return
    }
    // Why: if the user clicks through several rows quickly, discard stale
    // responses by tagging each request with a monotonic id and only applying
    // results whose id matches the latest one.
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    setLoading(true)
    setError(null)
    setDetails(null)
    setTab('conversation')

    window.api.gh
      .workItemDetails({ repoPath, number: workItem.number })
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setDetails(result)
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to load details')
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setLoading(false)
      })
  }, [repoPath, workItem])

  const Icon = workItem?.type === 'pr' ? GitPullRequest : CircleDot
  const body = details?.body ?? ''
  const comments = details?.comments ?? []
  const files = details?.files ?? []
  const checks = details?.checks ?? []

  return (
    // Why: the overlay sheet pops over page content rather than docking a
    // right column — Radix's Dialog handles focus trap, Esc-to-close, and
    // overlay click-outside, and the `slide-in-from-right` animation gives it
    // the Mantine-style drawer feel while keeping us on shadcn primitives.
    <Sheet open={workItem !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full p-0 sm:max-w-[640px]"
        onOpenAutoFocus={(event) => {
          // Why: focusing the first actionable element inside the drawer
          // causes the "Start workspace" footer button to receive focus and
          // get visually highlighted on open. Preventing auto-focus keeps the
          // drawer feeling like a passive preview until the user acts.
          event.preventDefault()
        }}
      >
        {/* Why: SheetTitle/Description are required by Radix Dialog for a11y,
            but the visible header already carries the same info. Wrap each
            individually with `asChild` so the visually-hidden span wraps the
            element cleanly — nesting a <h2>/<p> inside a single <span> would
            be invalid HTML. */}
        <VisuallyHidden.Root asChild>
          <SheetTitle>{workItem?.title ?? 'GitHub item'}</SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            Read-only preview of the selected GitHub issue or pull request.
          </SheetDescription>
        </VisuallyHidden.Root>

        {workItem && (
          <div className="flex h-full min-h-0 flex-col">
            {/* Header */}
            <div className="flex-none border-b border-border/60 px-4 py-3">
              <div className="flex items-start gap-2">
                <Icon className="mt-1 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                        getStateTone(workItem)
                      )}
                    >
                      {getStateLabel(workItem)}
                    </span>
                    <span className="font-mono text-[12px] text-muted-foreground">
                      #{workItem.number}
                    </span>
                  </div>
                  <h2 className="mt-1 text-[15px] font-semibold leading-tight text-foreground">
                    {workItem.title}
                  </h2>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{workItem.author ?? 'unknown'}</span>
                    <span>· {formatRelativeTime(workItem.updatedAt)}</span>
                    {workItem.branchName && (
                      <span className="font-mono text-[10px] text-muted-foreground/80">
                        · {workItem.branchName}
                      </span>
                    )}
                  </div>
                  {workItem.labels.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {workItem.labels.map((label) => (
                        <span
                          key={label}
                          className="rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => window.api.shell.openUrl(workItem.url)}
                        aria-label="Open on GitHub"
                      >
                        <ExternalLink className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      Open on GitHub
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

            {/* Tabs + body */}
            <div className="min-h-0 flex-1">
              {error ? (
                <div className="px-4 py-6 text-[12px] text-destructive">{error}</div>
              ) : (
                <Tabs
                  value={tab}
                  onValueChange={(value) => setTab(value as DrawerTab)}
                  className="flex h-full min-h-0 flex-col gap-0"
                >
                  <TabsList
                    variant="line"
                    className="mx-4 mt-2 justify-start gap-3 border-b border-border/60"
                  >
                    <TabsTrigger value="conversation" className="px-2">
                      <MessageSquare className="size-3.5" />
                      Conversation
                    </TabsTrigger>
                    {workItem.type === 'pr' && (
                      <>
                        <TabsTrigger value="files" className="px-2">
                          <FileText className="size-3.5" />
                          Files
                          {files.length > 0 && (
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              {files.length}
                            </span>
                          )}
                        </TabsTrigger>
                        <TabsTrigger value="checks" className="px-2">
                          Checks
                          {checks.length > 0 && (
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              {checks.length}
                            </span>
                          )}
                        </TabsTrigger>
                      </>
                    )}
                  </TabsList>

                  <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
                    <TabsContent value="conversation" className="mt-0">
                      <ConversationTab
                        item={workItem}
                        body={body}
                        comments={comments}
                        loading={loading}
                      />
                    </TabsContent>

                    {workItem.type === 'pr' && (
                      <TabsContent value="files" className="mt-0">
                        {loading && files.length === 0 ? (
                          <div className="flex items-center justify-center py-10">
                            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                          </div>
                        ) : files.length === 0 ? (
                          <div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
                            No files changed.
                          </div>
                        ) : (
                          <div>
                            {files.map((file) => (
                              <PRFileRow
                                key={file.path}
                                file={file}
                                repoPath={repoPath ?? ''}
                                prNumber={workItem.number}
                                headSha={details?.headSha}
                                baseSha={details?.baseSha}
                              />
                            ))}
                          </div>
                        )}
                      </TabsContent>
                    )}

                    {workItem.type === 'pr' && (
                      <TabsContent value="checks" className="mt-0">
                        <ChecksTab checks={checks} loading={loading} />
                      </TabsContent>
                    )}
                  </div>
                </Tabs>
              )}
            </div>

            {/* Footer */}
            <div className="flex-none border-t border-border/60 bg-background/40 px-4 py-3">
              <Button
                onClick={() => onUse(workItem)}
                className="w-full justify-center gap-2"
                aria-label={`Start workspace from ${workItem.type === 'pr' ? 'PR' : 'issue'}`}
              >
                {`Start workspace from ${workItem.type === 'pr' ? 'PR' : 'issue'}`}
                <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
