/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: PR detail,
   files, checks, and comments are loaded from Gitea IPC for the selected pull
   request, so local state resets when the selection prop changes. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, ExternalLink, GitPullRequest, LoaderCircle, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'
import { GiteaPrMergeButton } from '@/components/gitea-pr-merge-button'
import { GiteaPrTabBody } from '@/components/gitea-pr-tab-body'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type {
  GiteaComment,
  GiteaMergeMethod,
  GiteaPRCheck,
  GiteaPRFile,
  GiteaPRReviewComment,
  GiteaPullRequestDetail,
  GiteaWorkItem,
  Repo
} from '../../../shared/types'
import type { GiteaWorkspaceSelection } from './GiteaIssueWorkspace'
import { scoped } from './gitea-pr-request-scope'
import { translate } from '@/i18n/i18n'

// On Windows the custom window controls (minimize/close) float over the
// top-right corner, so the header action buttons must clear that strip.
const isWindows = !navigator.userAgent.includes('Mac') && navigator.userAgent.includes('Windows')

type Tab = 'conversation' | 'files' | 'checks'

type GiteaPullRequestWorkspaceProps = {
  selection: GiteaWorkspaceSelection | null
  onUse: (repo: Repo, item: GiteaWorkItem) => void
  onClose: () => void
}

export function GiteaPullRequestWorkspace({
  selection,
  onUse,
  onClose
}: GiteaPullRequestWorkspaceProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const [tab, setTab] = useState<Tab>('conversation')
  const [detail, setDetail] = useState<GiteaPullRequestDetail | null>(null)
  const [files, setFiles] = useState<GiteaPRFile[]>([])
  const [checks, setChecks] = useState<GiteaPRCheck[]>([])
  const [comments, setComments] = useState<GiteaComment[]>([])
  const [reviewComments, setReviewComments] = useState<GiteaPRReviewComment[]>([])
  const [loading, setLoading] = useState(false)
  const [sideBySide, setSideBySide] = useState(true)
  const [commentDraft, setCommentDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [merging, setMerging] = useState(false)
  const requestRef = useRef(0)

  const item = selection?.item ?? null
  const repo = selection?.repo ?? null
  const scope = selection?.scope ?? null

  useEffect(() => {
    if (!selection || !item || !scope) {
      return
    }
    requestRef.current += 1
    const requestId = requestRef.current
    setTab('conversation')
    setDetail(null)
    setFiles([])
    setChecks([])
    setComments([])
    setReviewComments([])
    setCommentDraft('')
    setLoading(true)
    void Promise.all([
      window.api.gitea.prDetail(
        scoped(scope, { number: item.number })
      ) as Promise<GiteaPullRequestDetail | null>,
      window.api.gitea.prFiles(scoped(scope, { number: item.number })) as Promise<GiteaPRFile[]>,
      window.api.gitea.issueComments(scoped(scope, { number: item.number })) as Promise<
        GiteaComment[]
      >,
      window.api.gitea.prReviewComments(scoped(scope, { number: item.number })) as Promise<
        GiteaPRReviewComment[]
      >
    ])
      .then(([prDetail, prFiles, prComments, prReviewComments]) => {
        if (requestId !== requestRef.current) {
          return
        }
        setDetail(prDetail)
        setFiles(prFiles)
        setComments(prComments)
        setReviewComments(prReviewComments)
        if (prDetail?.headSha) {
          void (
            window.api.gitea.prChecks(scoped(scope, { headSha: prDetail.headSha })) as Promise<
              GiteaPRCheck[]
            >
          )
            .then((result) => {
              if (requestId === requestRef.current) {
                setChecks(result)
              }
            })
            .catch(() => {
              // Why: keep checks state consistent and surface the failure.
              if (requestId === requestRef.current) {
                setChecks([])
                toast.error(
                  translate(
                    'auto.components.GiteaPullRequestWorkspace.c2d3e4f5a6',
                    'Failed to load PR checks.'
                  )
                )
              }
            })
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestRef.current) {
          setLoading(false)
        }
      })
  }, [selection, item, scope])

  const handleSubmitComment = useCallback(async (): Promise<void> => {
    if (!scope || !item || submitting) {
      return
    }
    const body = commentDraft.trim()
    if (!body) {
      return
    }
    setSubmitting(true)
    try {
      const result = await window.api.gitea.addIssueComment(
        scoped(scope, { number: item.number, body })
      )
      if (!result.ok) {
        throw new Error(result.error)
      }
      setComments((prev) => [
        ...prev,
        { id: Date.now(), body, createdAt: new Date().toISOString() }
      ])
      setCommentDraft('')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.GiteaPullRequestWorkspace.f5cf34ed40',
              'Failed to add comment.'
            )
      )
    } finally {
      setSubmitting(false)
    }
  }, [commentDraft, item, scope, submitting])

  const handleMerge = useCallback(
    async (method: GiteaMergeMethod): Promise<void> => {
      if (!scope || !item || merging) {
        return
      }
      setMerging(true)
      try {
        const result = await window.api.gitea.prMerge(
          scoped(scope, { number: item.number, method })
        )
        if (!result.ok) {
          throw new Error(result.error)
        }
        toast.success(
          translate('auto.components.GiteaPullRequestWorkspace.22f9c29c9b', 'Pull request merged.')
        )
        setDetail((prev) => (prev ? { ...prev, state: 'merged', merged: true } : prev))
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate('auto.components.GiteaPullRequestWorkspace.d93415a77d', 'Failed to merge.')
        )
      } finally {
        setMerging(false)
      }
    },
    [item, merging, scope]
  )

  const handleAddReviewComment = useCallback(
    async (path: string, line: number, body: string): Promise<boolean> => {
      if (!scope || !item) {
        return false
      }
      try {
        const result = await window.api.gitea.prAddReviewComment(
          scoped(scope, { number: item.number, path, line, body })
        )
        if (!result.ok) {
          throw new Error(result.error)
        }
        const refreshed = (await window.api.gitea.prReviewComments(
          scoped(scope, { number: item.number })
        )) as GiteaPRReviewComment[]
        setReviewComments(refreshed)
        return true
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.GiteaPullRequestWorkspace.c7c84081fc',
                'Failed to add review comment.'
              )
        )
        return false
      }
    },
    [item, scope]
  )

  const state = detail?.state ?? (item?.state === 'merged' ? 'merged' : item?.state) ?? 'open'
  const body = detail?.body?.trim()
  const tabs: { id: Tab; label: string; count?: number }[] = [
    {
      id: 'conversation',
      label: translate('auto.components.GiteaPullRequestWorkspace.f51240a59a', 'Conversation')
    },
    {
      id: 'files',
      label: translate('auto.components.GiteaPullRequestWorkspace.4f4abe43ab', 'Files'),
      count: files.length
    },
    {
      id: 'checks',
      label: translate('auto.components.GiteaPullRequestWorkspace.95a6c97ba6', 'Checks'),
      count: checks.length
    }
  ]

  return (
    <Sheet open={selection !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(96vw,1040px)] p-0 sm:max-w-[1040px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {item?.title ??
              translate(
                'auto.components.GiteaPullRequestWorkspace.8e44409da0',
                'Gitea pull request'
              )}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.GiteaPullRequestWorkspace.0a432f2c1a',
              'Review files, checks, and conversation, then merge or start work.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {selection && item && repo && scope ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
              <div className={cn('flex items-start gap-2', isWindows && 'pr-[140px]')}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  onClick={onClose}
                  aria-label={translate(
                    'auto.components.GiteaPullRequestWorkspace.5fa5ec9fff',
                    'Close'
                  )}
                >
                  <X className="size-4" />
                </Button>
                <Button onClick={() => onUse(repo, item)} className="shrink-0 gap-2" size="sm">
                  {translate(
                    'auto.components.GiteaPullRequestWorkspace.f88c7cf08c',
                    'Start workspace'
                  )}
                  <ArrowRight className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  onClick={() => window.api.shell.openUrl(item.url)}
                  aria-label={translate(
                    'auto.components.GiteaPullRequestWorkspace.9813b44d73',
                    'Open in Gitea'
                  )}
                >
                  <ExternalLink className="size-4" />
                </Button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <GitPullRequest className="size-3.5 text-muted-foreground" />
                    <span className="font-mono">#{item.number}</span>
                    {detail ? (
                      <span className="font-mono">
                        {detail.headBranch} → {detail.baseBranch}
                      </span>
                    ) : null}
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
                        state === 'merged'
                          ? 'bg-ai-action-accent/15 text-ai-action-accent'
                          : state === 'open'
                            ? 'bg-status-success/15 text-status-success'
                            : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {state}
                    </span>
                    {loading ? <LoaderCircle className="size-3 animate-spin" /> : null}
                  </div>
                  <h2 className="mt-1 text-[20px] font-semibold leading-tight text-foreground">
                    {item.title}
                  </h2>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-1">
                {tabs.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setTab(entry.id)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs transition',
                      tab === entry.id
                        ? 'bg-foreground/90 text-background'
                        : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                    )}
                  >
                    {entry.label}
                    {typeof entry.count === 'number' && entry.count > 0 ? (
                      <span className="ml-1 opacity-70">{entry.count}</span>
                    ) : null}
                  </button>
                ))}
                {state === 'open' ? (
                  <GiteaPrMergeButton
                    mergeable={detail?.mergeable}
                    merging={merging}
                    onMerge={(method) => void handleMerge(method)}
                  />
                ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
              <GiteaPrTabBody
                tab={tab}
                body={body}
                comments={comments}
                files={files}
                checks={checks}
                scope={scope}
                baseSha={detail?.baseSha ?? ''}
                headSha={detail?.headSha ?? ''}
                isDark={Boolean(isDark)}
                sideBySide={sideBySide}
                onToggleSideBySide={() => setSideBySide((value) => !value)}
                reviewComments={reviewComments}
                onAddReviewComment={handleAddReviewComment}
              />
            </div>

            {tab === 'conversation' ? (
              <div className="flex-none border-t border-border/50 bg-background px-3 py-3">
                <div className="flex gap-2">
                  <textarea
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    placeholder={translate(
                      'auto.components.GiteaPullRequestWorkspace.ddc99ed766',
                      'Add a comment...'
                    )}
                    rows={2}
                    disabled={submitting}
                    className="min-h-10 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                  <Button
                    onClick={() => void handleSubmitComment()}
                    disabled={!commentDraft.trim() || submitting}
                    className="self-end gap-2"
                  >
                    {submitting ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                    {translate('auto.components.GiteaPullRequestWorkspace.d646ddef48', 'Comment')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
