/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: the detail
   and comments are loaded from Gitea IPC for the selected work item, so local
   state must reset when the selection prop changes (mirrors JiraIssueWorkspace). */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  CircleDot,
  Clipboard,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  Send,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import type {
  GiteaComment,
  GiteaIssue,
  GiteaLabel,
  GiteaUser,
  GiteaWorkItem,
  Repo
} from '../../../shared/types'
import type { GiteaIssueScope } from '@/store/slices/gitea'
import { GiteaIssueMetaControls } from './gitea-issue-meta-controls'
import { GiteaIssueComments } from './gitea-issue-comments'
import { translate } from '@/i18n/i18n'

export type GiteaWorkspaceSelection = { repo: Repo; item: GiteaWorkItem; scope: GiteaIssueScope }

type GiteaIssueWorkspaceProps = {
  selection: GiteaWorkspaceSelection | null
  onUse: (repo: Repo, item: GiteaWorkItem) => void
  onClose: () => void
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.GiteaIssueWorkspace.47b064c003', '{{value0}} copied', {
        value0: label
      })
    )
  } catch {
    toast.error(translate('auto.components.GiteaIssueWorkspace.927222e135', 'Failed to copy.'))
  }
}

// On Windows the custom window controls float over the top-right corner, so the
// header action buttons must clear that strip.
const isWindows = !navigator.userAgent.includes('Mac') && navigator.userAgent.includes('Windows')

export function GiteaIssueWorkspace({
  selection,
  onUse,
  onClose
}: GiteaIssueWorkspaceProps): React.JSX.Element {
  const [detail, setDetail] = useState<GiteaIssue | null>(null)
  const [comments, setComments] = useState<GiteaComment[]>([])
  const [loading, setLoading] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [statePending, setStatePending] = useState(false)
  const [closed, setClosed] = useState(false)
  const [repoLabels, setRepoLabels] = useState<GiteaLabel[]>([])
  const [repoAssignees, setRepoAssignees] = useState<GiteaUser[]>([])
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
    const args = {
      repoPath: scope.repoPath,
      repoId: scope.repoId ?? null,
      sourceContext: scope.sourceContext ?? null,
      number: item.number
    }
    const listArgs = {
      repoPath: scope.repoPath,
      repoId: scope.repoId ?? null,
      sourceContext: scope.sourceContext ?? null
    }
    setDetail(null)
    setComments([])
    setCommentDraft('')
    setRepoLabels([])
    setRepoAssignees([])
    setClosed(item.state !== 'open')
    setLoading(true)
    // Why: load each resource independently so the issue body/comments still
    // render when only labels/assignees fail, and surface at least one error.
    void Promise.allSettled([
      window.api.gitea.issue(args) as Promise<GiteaIssue | null>,
      window.api.gitea.issueComments(args) as Promise<GiteaComment[]>,
      window.api.gitea.labels(listArgs) as Promise<GiteaLabel[]>,
      window.api.gitea.assignees(listArgs) as Promise<GiteaUser[]>
    ])
      .then(([issueResult, commentsResult, labelsResult, assigneesResult]) => {
        if (requestId !== requestRef.current) {
          return
        }
        if (issueResult.status === 'fulfilled') {
          setDetail(issueResult.value)
          if (issueResult.value) {
            setClosed(issueResult.value.state !== 'open')
          }
        }
        if (commentsResult.status === 'fulfilled') {
          setComments(commentsResult.value)
        }
        if (labelsResult.status === 'fulfilled') {
          setRepoLabels(labelsResult.value)
        }
        if (assigneesResult.status === 'fulfilled') {
          setRepoAssignees(assigneesResult.value)
        }
        if (
          [issueResult, commentsResult, labelsResult, assigneesResult].some(
            (result) => result.status === 'rejected'
          )
        ) {
          toast.error(
            translate('auto.components.GiteaIssueWorkspace.b7c8d9e0f1', 'Failed to load issue.')
          )
        }
      })
      .finally(() => {
        if (requestId === requestRef.current) {
          setLoading(false)
        }
      })
  }, [selection, item, scope])

  // Light refetch of just the issue detail after a metadata edit, so labels /
  // assignees / title update without resetting comments or the comment draft.
  const refreshDetail = useCallback(async (): Promise<void> => {
    if (!scope || !item) {
      return
    }
    const issue = (await window.api.gitea.issue({
      repoPath: scope.repoPath,
      repoId: scope.repoId ?? null,
      sourceContext: scope.sourceContext ?? null,
      number: item.number
    })) as GiteaIssue | null
    if (issue) {
      setDetail(issue)
      setClosed(issue.state !== 'open')
    }
  }, [scope, item])

  const handleToggleState = useCallback(async (): Promise<void> => {
    if (!scope || !item || statePending) {
      return
    }
    const nextState = closed ? 'open' : 'closed'
    setStatePending(true)
    try {
      const result = await window.api.gitea.updateIssue({
        repoPath: scope.repoPath,
        repoId: scope.repoId ?? null,
        sourceContext: scope.sourceContext ?? null,
        number: item.number,
        updates: { state: nextState }
      })
      if (!result.ok) {
        throw new Error(result.error)
      }
      setClosed(nextState === 'closed')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.GiteaIssueWorkspace.2d2e69fe70', 'Failed to update issue.')
      )
    } finally {
      setStatePending(false)
    }
  }, [closed, item, scope, statePending])

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
      const result = await window.api.gitea.addIssueComment({
        repoPath: scope.repoPath,
        repoId: scope.repoId ?? null,
        sourceContext: scope.sourceContext ?? null,
        number: item.number,
        body
      })
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
          : translate('auto.components.GiteaIssueWorkspace.565680a39b', 'Failed to add comment.')
      )
    } finally {
      setSubmitting(false)
    }
  }, [commentDraft, item, scope, submitting])

  const title = detail?.title ?? item?.title ?? ''
  const body = detail?.body?.trim()
  const labels = detail?.labels ?? item?.labels ?? []

  return (
    <Sheet open={selection !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,780px)] p-0 sm:max-w-[780px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {title || translate('auto.components.GiteaIssueWorkspace.a792c22414', 'Gitea item')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.GiteaIssueWorkspace.01b6ea43ca',
              'Preview and start work from the selected Gitea item.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {selection && item && repo ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
              <div className={cn('flex items-start gap-2', isWindows && 'pr-[140px]')}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  onClick={onClose}
                  aria-label={translate('auto.components.GiteaIssueWorkspace.ce513e3ca2', 'Close')}
                >
                  <X className="size-4" />
                </Button>
                <Button onClick={() => onUse(repo, item)} className="shrink-0 gap-2" size="sm">
                  {translate('auto.components.GiteaIssueWorkspace.e849a4c80f', 'Start workspace')}
                  <ArrowRight className="size-4" />
                </Button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="text-muted-foreground">
                      {item.type === 'pull' ? (
                        <GitPullRequest className="size-3.5" />
                      ) : (
                        <CircleDot className="size-3.5" />
                      )}
                    </span>
                    <span className="font-mono">#{item.number}</span>
                    {item.serverName ? <span>{item.serverName}</span> : null}
                    <span>{repo.displayName}</span>
                    {loading ? <LoaderCircle className="size-3 animate-spin" /> : null}
                  </div>
                  <h2 className="mt-1 text-[20px] font-semibold leading-tight text-foreground">
                    {title}
                  </h2>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                    closed
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-status-success/15 text-status-success'
                  )}
                >
                  {closed
                    ? translate('auto.components.GiteaIssueWorkspace.c0d4f97901', 'Closed')
                    : translate('auto.components.GiteaIssueWorkspace.ab08895bb5', 'Open')}
                </span>
                {item.type === 'issue' ? (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => void handleToggleState()}
                    disabled={statePending}
                    className="gap-1"
                  >
                    {statePending ? <LoaderCircle className="size-3 animate-spin" /> : null}
                    {closed
                      ? translate('auto.components.GiteaIssueWorkspace.1ab551635b', 'Reopen')
                      : translate('auto.components.GiteaIssueWorkspace.6b3c5a3144', 'Close issue')}
                  </Button>
                ) : null}
                {labels.map((label) => (
                  <span
                    key={label}
                    className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {label}
                  </span>
                ))}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => window.api.shell.openUrl(item.url)}
                    aria-label={translate(
                      'auto.components.GiteaIssueWorkspace.63cbb99973',
                      'Open in Gitea'
                    )}
                  >
                    <ExternalLink className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void copyText(item.url, 'URL')}
                    aria-label={translate(
                      'auto.components.GiteaIssueWorkspace.c29b657be3',
                      'Copy URL'
                    )}
                  >
                    <Clipboard className="size-4" />
                  </Button>
                </div>
              </div>
            </div>

            {item.type === 'issue' ? (
              <GiteaIssueMetaControls
                scope={selection.scope}
                issueNumber={item.number}
                title={title}
                labelNames={labels}
                assigneeLogins={(detail?.assignees ?? []).map((user) => user.login)}
                repoLabels={repoLabels}
                repoAssignees={repoAssignees}
                onChanged={() => void refreshDetail()}
              />
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
              <section className="border-b border-border/40 px-4 py-4">
                {body ? (
                  <CommentMarkdown content={body} className="text-[14px] leading-relaxed" />
                ) : (
                  <p className="text-sm italic text-muted-foreground">
                    {translate(
                      'auto.components.GiteaIssueWorkspace.ca242eaf5d',
                      'No description provided.'
                    )}
                  </p>
                )}
              </section>
              <GiteaIssueComments comments={comments} />
            </div>

            <div className="flex-none border-t border-border/50 bg-background px-3 py-3">
              <div className="flex gap-2">
                <textarea
                  value={commentDraft}
                  onChange={(event) => setCommentDraft(event.target.value)}
                  placeholder={translate(
                    'auto.components.GiteaIssueWorkspace.0fee3f06ff',
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
                  {translate('auto.components.GiteaIssueWorkspace.d3e0033e0f', 'Comment')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
