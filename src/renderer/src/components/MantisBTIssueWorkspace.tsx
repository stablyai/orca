import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, LoaderCircle, X } from 'lucide-react'
import { VisuallyHidden } from 'radix-ui'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { mantisBTGetIssue } from '@/runtime/runtime-mantisbt-client'
import type { MantisBTIssue } from '../../../shared/mantisbt-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { getMantisBTStatusTone } from '@/components/task-page-mantisbt-status-tone'
import { getMantisBTIssueWorkspaceActions } from '@/components/mantisbt-issue-workspace-actions'

type MantisBTIssueWorkspaceProps = {
  issue: MantisBTIssue | null
  onUse: (issue: MantisBTIssue) => void
  onClose: () => void
  sourceContext?: TaskSourceContext | null
}

export default function MantisBTIssueWorkspace({
  issue,
  onUse,
  onClose,
  sourceContext
}: MantisBTIssueWorkspaceProps): React.JSX.Element {
  const providerSettings = sourceContext
  const [fetchedIssue, setFetchedIssue] = useState<{ id: string; issue: MantisBTIssue } | null>(
    null
  )
  const [issueLoading, setIssueLoading] = useState(false)
  const requestIdRef = useRef(0)

  // Why: the freshly fetched issue is only usable while it still matches the
  // selected issue's id — derived directly from state rather than synced via
  // an effect, so switching issues never flashes stale fetched content.
  const displayed = issue && fetchedIssue?.id === issue.id ? fetchedIssue.issue : issue

  useEffect(() => {
    if (!issue) {
      setIssueLoading(false)
      return
    }
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    setIssueLoading(true)
    void mantisBTGetIssue(providerSettings, issue.id, issue.siteId)
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (result) {
          setFetchedIssue({ id: issue.id, issue: result })
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setIssueLoading(false)
        }
      })
  }, [issue, providerSettings])

  const actionItems = useMemo(
    () => (displayed ? getMantisBTIssueWorkspaceActions(displayed) : []),
    [displayed]
  )
  const handleUse = useCallback(() => {
    if (displayed) {
      onUse(displayed)
    }
  }, [displayed, onUse])

  return (
    <Sheet open={issue !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,780px)] sm:max-w-[780px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {displayed?.summary ??
              translate('auto.components.MantisBTIssueWorkspace.title', 'MantisBT issue')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.MantisBTIssueWorkspace.description',
              'Preview the selected issue and start work from it.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {displayed ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="font-mono">#{displayed.id}</span>
                    {displayed.siteName ? <span>{displayed.siteName}</span> : null}
                    <span>{displayed.project.name}</span>
                    <span>{formatUiRelativeTimeFromDate(displayed.updatedAt)}</span>
                    {issueLoading ? <LoaderCircle className="size-3 animate-spin" /> : null}
                  </div>
                  <h2 className="mt-1 text-[20px] font-semibold leading-tight text-foreground">
                    {displayed.summary}
                  </h2>
                </div>
                <Button onClick={handleUse} className="hidden shrink-0 sm:inline-flex" size="sm">
                  {translate(
                    'auto.components.MantisBTIssueWorkspace.startWorkspace',
                    'Start workspace'
                  )}
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
                        'auto.components.MantisBTIssueWorkspace.close',
                        'Close MantisBT issue preview'
                      )}
                    >
                      <X className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {translate('auto.components.MantisBTIssueWorkspace.closeShort', 'Close')}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border/40 px-4 py-3">
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[12px] font-medium ${getMantisBTStatusTone(displayed.status.id)}`}
              >
                {displayed.status.name}
              </span>
              {displayed.priority ? (
                <span className="inline-flex items-center rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[12px] text-muted-foreground">
                  {displayed.priority.name}
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[12px] text-muted-foreground">
                <span className="flex size-4 items-center justify-center rounded-full bg-background text-[9px]">
                  {(displayed.handler?.realName || displayed.handler?.name)?.slice(0, 1) ?? '-'}
                </span>
                {displayed.handler?.realName ||
                  displayed.handler?.name ||
                  translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
              </span>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_228px]">
              <div className="min-h-0 overflow-y-auto scrollbar-sleek">
                <section className="px-4 py-4">
                  {displayed.description?.trim() ? (
                    <CommentMarkdown
                      content={displayed.description}
                      variant="document"
                      className="text-[14px] leading-relaxed"
                    />
                  ) : (
                    <p className="text-sm italic text-muted-foreground">
                      {translate(
                        'auto.components.MantisBTIssueWorkspace.noDescription',
                        'No description provided.'
                      )}
                    </p>
                  )}
                </section>
              </div>

              <aside className="border-t border-border/50 bg-muted/20 px-3 py-3 xl:border-l xl:border-t-0">
                <Button onClick={handleUse} className="mb-3 w-full justify-center sm:hidden">
                  {translate(
                    'auto.components.MantisBTIssueWorkspace.startWorkspace',
                    'Start workspace'
                  )}
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
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
