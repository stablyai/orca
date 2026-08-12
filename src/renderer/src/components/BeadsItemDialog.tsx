import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  FolderKanban,
  LoaderCircle,
  Plus
} from 'lucide-react'
import { toast } from 'sonner'

import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import { translate } from '@/i18n/i18n'
import {
  findBeadsIssueWorkspaceAttachment,
  getBeadsIssueWorkspaceAttachmentLabel
} from '@/lib/beads-issue-workspace-attachment'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { beadsGetIssue, isBeadsTaskSourceUnsupportedError } from '@/runtime/runtime-beads-client'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import type { BeadsIssue } from '../../../shared/beads-types'
import { BeadsItemDetailMeta } from './task-page-beads-detail-meta'
import type { TaskPageBeadsIssueRow } from './task-page-beads-issues'
import {
  BEADS_STATUS_ICONS,
  getBeadsStatusDetailTone,
  getBeadsStatusLabels
} from './task-page-beads-status-visuals'

type BeadsItemDialogProps = {
  row: TaskPageBeadsIssueRow
  /** Repo display name for the breadcrumb; beads has no owner/repo slug. */
  repoName: string | null
  backLabel?: string
  onUse: (row: TaskPageBeadsIssueRow) => void
  onClose: () => void
}

function getBeadsDetailLoadFailedMessage(): string {
  return translate(
    'auto.components.TaskPage.beadsDetailLoadFailed',
    'Unable to load details for this Beads issue.'
  )
}

/** Full-surface beads issue detail mirroring GitHubItemDialog's issue-page layout. */
export default function BeadsItemDialog({
  row,
  repoName,
  backLabel = 'Beads list',
  onUse,
  onClose
}: BeadsItemDialogProps): React.JSX.Element {
  // Why: the list row is the synchronous shell; `bd show` replaces it with the enriched issue (description, counts).
  const [issue, setIssue] = useState<BeadsIssue>(row.issue)
  const [detailsLoaded, setDetailsLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [idCopied, setIdCopied] = useState(false)
  const idCopiedResetTimerRef = useRef<number | null>(null)
  const { sourceContext } = row
  const repoId = sourceContext.repoId ?? null
  const issueId = row.issue.id

  useEffect(() => {
    if (!repoId) {
      setLoading(false)
      setError(getBeadsDetailLoadFailedMessage())
      return
    }
    let cancelled = false
    beadsGetIssue(sourceContext, { repoId, id: issueId })
      .then((result) => {
        if (cancelled) {
          return
        }
        if (result.issue) {
          setIssue(result.issue)
          setDetailsLoaded(true)
        } else {
          // Why: null means bd is missing/outdated/uninitialized here, not an empty issue.
          setError(getBeadsDetailLoadFailedMessage())
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            isBeadsTaskSourceUnsupportedError(err) ? err.message : getBeadsDetailLoadFailedMessage()
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [sourceContext, repoId, issueId])

  useEffect(
    () => () => {
      if (idCopiedResetTimerRef.current !== null) {
        window.clearTimeout(idCopiedResetTimerRef.current)
      }
    },
    []
  )

  const allWorktrees = useAllWorktrees()
  const attachedWorkspace = useMemo(
    () => findBeadsIssueWorkspaceAttachment(allWorktrees, repoId, issueId),
    [allWorktrees, repoId, issueId]
  )
  const attachedWorkspaceLabel = attachedWorkspace
    ? getBeadsIssueWorkspaceAttachmentLabel(attachedWorkspace)
    : null

  const handleUse = useCallback((): void => {
    onUse({ issue, sourceContext })
  }, [issue, onUse, sourceContext])

  const handleOpenOrUseWorkspace = useCallback((): void => {
    const currentAttached = findBeadsIssueWorkspaceAttachment(
      useAppStore.getState().allWorktrees(),
      repoId,
      issueId
    )
    if (!currentAttached) {
      handleUse()
      return
    }
    const result = activateAndRevealWorktree(currentAttached.id)
    if (result === false) {
      toast.error(
        translate(
          'auto.components.GitHubItemDialog.2ef631437e',
          'Unable to open the workspace attached to this issue.'
        )
      )
    }
  }, [handleUse, issueId, repoId])

  const handleCopyIssueId = useCallback(async (): Promise<void> => {
    const idLabel = translate('auto.components.TaskPage.eb10c32872', 'ID')
    try {
      await window.api.ui.writeClipboardText(issueId)
      if (idCopiedResetTimerRef.current !== null) {
        window.clearTimeout(idCopiedResetTimerRef.current)
      }
      setIdCopied(true)
      idCopiedResetTimerRef.current = window.setTimeout(() => {
        idCopiedResetTimerRef.current = null
        setIdCopied(false)
      }, 1500)
      toast.success(
        translate('auto.components.TaskPage.beadsCopySuccess', '{{value0}} copied', {
          value0: idLabel
        })
      )
    } catch {
      toast.error(
        translate('auto.components.TaskPage.beadsCopyFailure', 'Failed to copy {{value0}}', {
          value0: idLabel.toLowerCase()
        })
      )
    }
  }, [issueId])

  const statusLabels = getBeadsStatusLabels()
  const StatusIcon = BEADS_STATUS_ICONS[issue.status]
  const description = issue.description ?? ''

  return (
    <div
      data-testid="beads-item-detail"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm"
    >
      <div className="flex h-full min-h-0 flex-col">
        {/* Row 1: breadcrumb strip, same chrome as the GitHub issue page */}
        <div className="flex-none border-b border-border/60 bg-muted/30 px-6 py-2.5">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="-ml-2 h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
              aria-label={backLabel}
            >
              <ChevronLeft className="size-4" />
              {backLabel}
            </Button>
            <span className="text-border">·</span>
            {repoName ? (
              <>
                <span className="truncate font-medium text-foreground">{repoName}</span>
                <span className="text-muted-foreground/60">·</span>
              </>
            ) : null}
            <span className="font-mono text-muted-foreground">{issue.id}</span>
            <div className="ml-auto flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void handleCopyIssueId()}
                    aria-label={translate('auto.components.TaskPage.beadsCopyId', 'Copy ID')}
                  >
                    {idCopied ? (
                      <Check className="size-4 text-emerald-500" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {idCopied
                    ? translate('auto.components.GitHubItemDialog.038b3d39b1', 'Copied')
                    : translate('auto.components.TaskPage.beadsCopyId', 'Copy ID')}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>

        {/* Row 2: large title block */}
        <div className="flex-none border-b border-border/60 bg-card px-6 py-4">
          <div className="flex items-start gap-4">
            <h1 className="min-w-0 flex-1 text-[28px] font-medium leading-tight text-foreground">
              <span className="break-words">{issue.title}</span>
              <span className="ml-2 font-mono text-[20px] font-light text-muted-foreground">
                {issue.id}
              </span>
            </h1>
            <div className="flex shrink-0 items-center gap-2">
              {attachedWorkspace ? (
                <DropdownMenu modal={false}>
                  <ButtonGroup>
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleOpenOrUseWorkspace}
                      className="gap-1.5 whitespace-nowrap"
                      aria-label={translate(
                        'auto.components.GitHubItemDialog.84855fedd0',
                        'Open workspace attached to issue'
                      )}
                    >
                      {translate('auto.components.GitHubItemDialog.726db41722', 'Open workspace')}
                      <ArrowRight className="size-3.5" />
                    </Button>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="icon-sm"
                        aria-label={translate(
                          'auto.components.GitHubItemDialog.fe6ff12dc2',
                          'More issue workspace actions'
                        )}
                      >
                        <ChevronDown className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                  </ButtonGroup>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={handleUse}>
                      <Plus className="size-4" />
                      {translate(
                        'auto.components.GitHubItemDialog.36182aa57f',
                        'Start new workspace'
                      )}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={handleUse}
                  className="gap-1.5 whitespace-nowrap"
                  aria-label={translate(
                    'auto.components.GitHubItemDialog.0ab4664a8b',
                    'Start workspace from issue'
                  )}
                >
                  {translate(
                    'auto.components.GitHubItemDialog.0ab4664a8b',
                    'Start workspace from issue'
                  )}
                  <ArrowRight className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium',
                getBeadsStatusDetailTone(issue.status)
              )}
            >
              <StatusIcon className="size-3.5" />
              {statusLabels[issue.status]}
            </span>
            {issue.createdBy ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold text-foreground">{issue.createdBy}</span>
                <span>
                  {translate('auto.components.GitHubItemDialog.55962099bc', 'opened this issue')}
                </span>
                <span className="text-muted-foreground/80">
                  {translate('auto.components.GitHubItemDialog.10ef1afb8e', '· updated')}
                  {formatRelativeTime(issue.updatedAt)}
                </span>
              </span>
            ) : (
              <span>
                {translate(
                  'auto.components.TaskPage.beadsDetailOpenedUpdated',
                  'opened {{value0}} · updated {{value1}}',
                  {
                    value0: formatRelativeTime(issue.createdAt),
                    value1: formatRelativeTime(issue.updatedAt)
                  }
                )}
              </span>
            )}
            {attachedWorkspaceLabel ? (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <FolderKanban className="size-3.5 shrink-0" />
                <span className="truncate">{attachedWorkspaceLabel}</span>
              </span>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1">
          {error ? (
            <div className="px-4 py-6 text-[12px] text-destructive">{error}</div>
          ) : (
            <div className="h-full min-h-0 overflow-y-auto scrollbar-sleek bg-background">
              {/* Why: px-2 + inner px-4 = header px-6, same rhythm as the GitHub issue page. */}
              <div className="w-full px-2 py-6">
                <div className="mb-5 border-b border-border/60 px-4 pb-5">
                  <BeadsItemDetailMeta
                    issue={issue}
                    sourceContext={sourceContext}
                    attachedWorkspaceLabel={attachedWorkspaceLabel}
                    onIssueChange={setIssue}
                  />
                </div>
                <div className="min-w-0 px-4">
                  <div className="rounded-lg border border-border/50 bg-card/50 shadow-xs">
                    <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-[12px] text-muted-foreground">
                      {issue.createdBy ? (
                        <span className="font-medium text-foreground">{issue.createdBy}</span>
                      ) : (
                        <span className="font-mono font-medium text-foreground">{issue.id}</span>
                      )}
                      <span>
                        {translate('auto.components.GitHubItemDialog.8223320f8d', 'updated')}{' '}
                        {formatRelativeTime(issue.updatedAt)}
                      </span>
                    </div>
                    <div className="px-4 py-4 text-[14px] leading-relaxed text-foreground">
                      {loading && !detailsLoaded ? (
                        <div className="flex items-center justify-center py-5">
                          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                        </div>
                      ) : description.trim() ? (
                        <CommentMarkdown
                          content={description}
                          variant="document"
                          className="min-w-0 max-w-full overflow-hidden break-words text-[14px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
                        />
                      ) : (
                        <span className="italic text-muted-foreground">
                          {translate(
                            'auto.components.GitHubItemDialog.9b9cb55994',
                            'No description provided.'
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
