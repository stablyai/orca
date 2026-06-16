import React from 'react'
import { ArrowRight, CheckCircle2, Circle, LoaderCircle, Save, Send, X } from 'lucide-react'
import { VisuallyHidden } from 'radix-ui'

import { AsanaIcon } from '@/components/icons/AsanaIcon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { AsanaUserAvatar } from '@/components/AsanaUserAvatar'
import type { AsanaTask } from '../../../shared/types'
import { translate } from '@/i18n/i18n'
import { formatRelativeTime } from './asana-task-drawer-format'
import { AsanaTaskComments } from './AsanaTaskComments'
import { useAsanaTaskDrawer } from './use-asana-task-drawer'

export { buildAsanaBranchName } from './asana-task-drawer-format'

type AsanaIssueWorkspaceProps = {
  task: AsanaTask | null
  onUse: (task: AsanaTask) => void
  onClose: () => void
}

export default function AsanaIssueWorkspace({
  task,
  onUse,
  onClose
}: AsanaIssueWorkspaceProps): React.JSX.Element {
  const {
    displayed,
    projectLabel,
    taskLoading,
    pendingField,
    users,
    comments,
    commentsLoading,
    commentsError,
    titleDraft,
    setTitleDraft,
    notesDraft,
    setNotesDraft,
    commentDraft,
    setCommentDraft,
    commentSubmitting,
    requestIdRef,
    loadComments,
    mutateTask,
    handleSaveTitle,
    handleSaveNotes,
    handleToggleCompleted,
    handleSetApproval,
    handleSubmitComment,
    actionItems
  } = useAsanaTaskDrawer(task)

  return (
    <Sheet open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,780px)] p-0 sm:max-w-[780px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>{displayed?.title ?? 'Asana task'}</SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.AsanaIssueWorkspace.d714b420a0',
              'Preview, edit, and start work from the selected task.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {displayed ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    {displayed.workspaceName ? <span>{displayed.workspaceName}</span> : null}
                    <span>{projectLabel}</span>
                    <span>{formatRelativeTime(displayed.updatedAt)}</span>
                    {taskLoading ? <LoaderCircle className="size-3 animate-spin" /> : null}
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
                  {translate('auto.components.AsanaIssueWorkspace.80593bc32c', 'Start workspace')}
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
                        'auto.components.AsanaIssueWorkspace.c8ea562d51',
                        'Close Asana task preview'
                      )}
                    >
                      <X className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {translate('auto.components.AsanaIssueWorkspace.70508a18ed', 'Close')}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
              {displayed.resourceSubtype === 'approval' ? (
                <div className="flex items-center gap-1.5">
                  {pendingField === 'approval' ? (
                    <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
                  ) : null}
                  {(
                    [
                      {
                        status: 'approved',
                        label: translate(
                          'auto.components.AsanaIssueWorkspace.64974917e5',
                          'Approve'
                        )
                      },
                      {
                        status: 'changes_requested',
                        label: translate(
                          'auto.components.AsanaIssueWorkspace.570fa07349',
                          'Request changes'
                        )
                      },
                      {
                        status: 'rejected',
                        label: translate('auto.components.AsanaIssueWorkspace.c13fceb092', 'Reject')
                      }
                    ] as const
                  ).map(({ status, label }) => {
                    const active = displayed.approvalStatus === status
                    return (
                      <button
                        key={status}
                        type="button"
                        disabled={pendingField === 'approval'}
                        onClick={() => handleSetApproval(status)}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition hover:opacity-80 disabled:opacity-50',
                          active
                            ? status === 'approved'
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
                              : status === 'rejected'
                                ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-200'
                                : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200'
                            : 'border-border/50 bg-muted/40 text-muted-foreground'
                        )}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <button
                  type="button"
                  disabled={pendingField === 'completed'}
                  onClick={handleToggleCompleted}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition hover:opacity-80 disabled:opacity-50',
                    displayed.completed
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
                      : 'border-border/50 bg-muted/40 text-muted-foreground'
                  )}
                >
                  {pendingField === 'completed' ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : displayed.completed ? (
                    <CheckCircle2 className="size-3" />
                  ) : (
                    <Circle className="size-3" />
                  )}
                  {displayed.completed
                    ? translate('auto.components.AsanaIssueWorkspace.98229f40ea', 'Completed')
                    : translate('auto.components.AsanaIssueWorkspace.dad2b1d01f', 'Mark complete')}
                </button>
              )}

              {displayed.dueOn ? (
                <span className="text-[11px] text-muted-foreground">
                  {translate('auto.components.AsanaIssueWorkspace.b3b8e19ea8', 'Due')}{' '}
                  {displayed.dueOn}
                </span>
              ) : null}

              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={pendingField === 'assignee'}
                    className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted/40 disabled:opacity-50"
                  >
                    {displayed.assignee ? <AsanaUserAvatar user={displayed.assignee} /> : null}
                    {displayed.assignee?.name ?? '+ Assignee'}
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
                      void mutateTask('assignee', { assigneeGid: null }, { assignee: undefined })
                    }
                    className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
                  >
                    {translate('auto.components.AsanaIssueWorkspace.826e6443f8', 'Unassigned')}
                  </button>
                  {users.map((user) => (
                    <button
                      key={user.gid}
                      type="button"
                      onClick={() =>
                        void mutateTask('assignee', { assigneeGid: user.gid }, { assignee: user })
                      }
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
                    >
                      <AsanaUserAvatar user={user} />
                      <span className="min-w-0 truncate">{user.name}</span>
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
                      {translate('auto.components.AsanaIssueWorkspace.073516facf', 'Title')}
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
                        aria-label={translate(
                          'auto.components.AsanaIssueWorkspace.b160e69749',
                          'Save title'
                        )}
                      >
                        {pendingField === 'title' ? (
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
                    <AsanaIcon className="size-3 text-muted-foreground" />
                    <span className="text-xs font-medium text-foreground">
                      {translate('auto.components.AsanaIssueWorkspace.1fd599c26c', 'Description')}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {projectLabel} · {displayed.assignee?.name ?? 'Unassigned'}
                    </span>
                  </div>
                  <div className="grid gap-2">
                    <textarea
                      value={notesDraft}
                      onChange={(event) => setNotesDraft(event.target.value)}
                      placeholder={translate(
                        'auto.components.AsanaIssueWorkspace.312fe2188b',
                        'No description provided.'
                      )}
                      rows={5}
                      className="min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleSaveNotes}
                        disabled={pendingField === 'notes'}
                        className="gap-2"
                      >
                        {pendingField === 'notes' ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Save className="size-4" />
                        )}
                        {translate(
                          'auto.components.AsanaIssueWorkspace.fd28d604ba',
                          'Save description'
                        )}
                      </Button>
                    </div>
                  </div>
                </section>

                <AsanaTaskComments
                  comments={comments}
                  commentsLoading={commentsLoading}
                  commentsError={commentsError}
                  onRetry={() => void loadComments(displayed, requestIdRef.current)}
                />
              </div>

              <aside className="border-t border-border/50 bg-muted/20 px-3 py-3 xl:border-l xl:border-t-0">
                <Button
                  onClick={() => onUse(displayed)}
                  className="mb-3 w-full justify-center gap-2 sm:hidden"
                >
                  {translate('auto.components.AsanaIssueWorkspace.80593bc32c', 'Start workspace')}
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
                    'auto.components.AsanaIssueWorkspace.f60c8c4109',
                    'Add an Asana comment...'
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
                  {translate('auto.components.AsanaIssueWorkspace.1bd0e2fc2d', 'Comment')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
