import React, { useCallback, useMemo } from 'react'
import { VisuallyHidden } from 'radix-ui'

import { LinearIssueTextEditor } from '@/components/LinearIssueTextEditor'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { findLinearIssueWorkspaceAttachment } from '@/lib/linear-issue-workspace-attachment'
import { openLinearIssueWorkspaceOrStart } from '@/lib/linear-issue-workspace-open'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { LinearIssueActivity } from './linear-issue-activity'
import { LinearIssueSubIssues } from './linear-issue-sub-issues'
import { useLinearIssueWorkspaceDetail } from './linear-issue-workspace-detail-state'
import { LinearIssueWorkspaceHeader } from './linear-issue-workspace-header'
import { LinearIssueWorkspaceSidebar } from './linear-issue-workspace-sidebar'

type LinearIssueWorkspaceProps = {
  issue: LinearIssue | null
  onUse: (issue: LinearIssue) => void
  onOpenIssue: (issue: LinearIssue) => void
  onClose: () => void
  variant?: 'sheet' | 'page'
  backLabel?: string
  sourceContext?: TaskSourceContext | null
}

type LinearIssueWorkspaceIssueProps = Omit<
  LinearIssueWorkspaceProps,
  'issue' | 'variant' | 'backLabel'
> & {
  issue: LinearIssue
  variant: 'sheet' | 'page'
  backLabel: string
  requestKey: string
}

function LinearIssueWorkspaceIssue({
  issue,
  onUse,
  onOpenIssue,
  onClose,
  variant,
  backLabel,
  sourceContext,
  requestKey
}: LinearIssueWorkspaceIssueProps): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const providerSettings = sourceContext ?? settings
  const allWorktrees = useAllWorktrees()
  const folderWorkspaces = useAppStore((state) => state.folderWorkspaces)
  const attachmentWorkspaces = useMemo(
    () => [...allWorktrees, ...folderWorkspaces.map(folderWorkspaceToWorktree)],
    [allWorktrees, folderWorkspaces]
  )
  const detail = useLinearIssueWorkspaceDetail({ issue, providerSettings, requestKey })
  const attachedWorkspace = useMemo(
    () => findLinearIssueWorkspaceAttachment(attachmentWorkspaces, detail.displayed),
    [attachmentWorkspaces, detail.displayed]
  )
  const attachedWorkspaceLabel = attachedWorkspace
    ? getWorktreeAttachmentLabel(attachedWorkspace)
    : null

  const handleUseIssue = useCallback((): void => {
    onUse(detail.displayed)
  }, [detail.displayed, onUse])

  const handleOpenOrUseIssue = useCallback((): void => {
    openLinearIssueWorkspaceOrStart(detail.displayed, () => onUse(detail.displayed))
  }, [detail.displayed, onUse])

  const content = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <LinearIssueWorkspaceHeader
        issue={detail.displayed}
        issueLoading={detail.issueLoading}
        attachedWorkspace={attachedWorkspace !== null}
        variant={variant}
        backLabel={backLabel}
        onClose={onClose}
        onOpenOrUseIssue={handleOpenOrUseIssue}
        onUseIssue={handleUseIssue}
      />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        <div className="mx-auto grid w-full grid-cols-1 gap-10 px-7 py-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:px-10 xl:px-12">
          <main className="min-w-0">
            <LinearIssueTextEditor
              issue={detail.displayed}
              onIssueChange={detail.handleIssueTextChange}
              sourceContext={sourceContext}
            />
            <LinearIssueSubIssues
              issue={detail.displayed}
              onOpenIssue={onOpenIssue}
              sourceContext={sourceContext}
            />
            <LinearIssueActivity
              issue={detail.displayed}
              comments={detail.comments}
              commentsLoading={detail.commentsLoading}
              commentsError={detail.commentsError}
              onRetryComments={detail.retryComments}
              onCommentAdded={detail.handleCommentAdded}
              sourceContext={sourceContext}
            />
          </main>
          <LinearIssueWorkspaceSidebar
            issue={detail.displayed}
            comments={detail.comments}
            editState={detail.editState}
            attachedWorkspaceLabel={attachedWorkspaceLabel}
            onEditStateChange={detail.handleEditStateChange}
            onProjectChanged={detail.handleProjectChanged}
            onOpenAttachedWorkspace={handleOpenOrUseIssue}
            sourceContext={sourceContext}
          />
        </div>
      </div>
    </div>
  )

  if (variant === 'page') {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
        {content}
      </div>
    )
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,1180px)] bg-background p-0 sm:max-w-[1180px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {detail.displayed.title ??
              translate('auto.components.LinearIssueWorkspace.61f424f8ca', 'Linear issue')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.LinearIssueWorkspace.ad5dec37b7',
              'Preview, edit, and start work from the selected issue.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>
        {content}
      </SheetContent>
    </Sheet>
  )
}

export default function LinearIssueWorkspace({
  issue,
  onUse,
  onOpenIssue,
  onClose,
  variant = 'sheet',
  backLabel = 'Back',
  sourceContext
}: LinearIssueWorkspaceProps): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  if (!issue) {
    if (variant === 'page') {
      return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm" />
      )
    }
    return <Sheet open={false} onOpenChange={(open) => !open && onClose()} />
  }
  const requestKey = `${sourceContext?.hostId ?? settings?.activeRuntimeEnvironmentId ?? 'local'}:${issue.workspaceId ?? 'selected'}:${issue.id}`
  return (
    <LinearIssueWorkspaceIssue
      key={requestKey}
      issue={issue}
      onUse={onUse}
      onOpenIssue={onOpenIssue}
      onClose={onClose}
      variant={variant}
      backLabel={backLabel}
      sourceContext={sourceContext}
      requestKey={requestKey}
    />
  )
}
