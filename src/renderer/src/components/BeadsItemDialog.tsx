import React, { useCallback, useMemo } from 'react'
import { ArrowRight, ChevronDown, ChevronLeft, FolderKanban, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import { translate } from '@/i18n/i18n'
import {
  findBeadsIssueWorkspaceAttachment,
  getBeadsIssueWorkspaceAttachmentLabel
} from '@/lib/beads-issue-workspace-attachment'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { BeadsItemDetailBodySections } from './task-page-beads-detail-body'
import {
  BeadsItemDetailComments,
  BeadsItemDetailCommentsSkeleton
} from './task-page-beads-detail-comments'
import { BeadsIssueIdCopyButton } from './task-page-beads-detail-copy-id'
import { BeadsItemDetailMeta } from './task-page-beads-detail-meta'
import { useBeadsIssueDetailNavigation } from './task-page-beads-detail-navigation'
import {
  BeadsItemDetailRelations,
  BeadsItemDetailRelationsSkeleton
} from './task-page-beads-detail-relations'
import type { TaskPageBeadsIssueRow } from './task-page-beads-issues'
import { groupBeadsIssueRelations } from './task-page-beads-relation-groups'
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

/** Full-surface beads issue detail mirroring GitHubItemDialog's issue-page layout. */
export default function BeadsItemDialog({
  row,
  repoName,
  backLabel = 'Beads list',
  onUse,
  onClose
}: BeadsItemDialogProps): React.JSX.Element {
  const { sourceContext } = row
  const repoId = sourceContext.repoId ?? null
  const {
    issue,
    setIssue,
    details,
    sectionsState,
    loading,
    detailsLoaded,
    error,
    previousIssue,
    navigateToIssue,
    navigateBack,
    applyDetails
  } = useBeadsIssueDetailNavigation(sourceContext, row.issue)
  const issueId = issue.id

  const relationGroups = useMemo(
    () => (details ? groupBeadsIssueRelations(details) : []),
    [details]
  )

  const handleBack = useCallback((): void => {
    if (!navigateBack()) {
      onClose()
    }
  }, [navigateBack, onClose])

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

  const statusLabels = getBeadsStatusLabels()
  const StatusIcon = BEADS_STATUS_ICONS[issue.status]

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
              onClick={handleBack}
              className="-ml-2 h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
              aria-label={previousIssue ? previousIssue.id : backLabel}
            >
              <ChevronLeft className="size-4" />
              {/* Why: mid-navigation the breadcrumb points at the previous issue, not the list. */}
              {previousIssue ? <span className="font-mono">{previousIssue.id}</span> : backLabel}
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
              <BeadsIssueIdCopyButton issueId={issueId} />
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
                {sectionsState === 'loaded' && relationGroups.length > 0 ? (
                  <div className="mb-5 border-b border-border/60 px-4 pb-5">
                    <BeadsItemDetailRelations
                      groups={relationGroups}
                      onNavigate={navigateToIssue}
                    />
                  </div>
                ) : sectionsState === 'loading' &&
                  issue.dependencyCount + issue.dependentCount > 0 ? (
                  <div className="mb-5 border-b border-border/60 px-4 pb-5">
                    <BeadsItemDetailRelationsSkeleton />
                  </div>
                ) : null}
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
                    <BeadsItemDetailBodySections
                      issue={issue}
                      pending={loading && !detailsLoaded}
                    />
                  </div>
                  {sectionsState === 'loaded' && details ? (
                    <div className="mt-4 min-w-0">
                      <BeadsItemDetailComments
                        sourceContext={sourceContext}
                        issueId={issueId}
                        details={details}
                        onDetailsChange={applyDetails}
                      />
                    </div>
                  ) : sectionsState === 'loading' ? (
                    <BeadsItemDetailCommentsSkeleton />
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
