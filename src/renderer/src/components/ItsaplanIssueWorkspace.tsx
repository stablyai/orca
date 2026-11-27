import React, { useEffect, useState } from 'react'
import { ArrowRight, ChevronLeft, ExternalLink, LoaderCircle } from 'lucide-react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ItsaplanIcon } from '@/components/icons/ItsaplanIcon'
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import type { ItsaplanIssue } from '../../../shared/itsaplan/itsaplan-types'
import { ItsaplanStatePill } from './task-page/itsaplan/listing/ItsaplanIssueRow'
import {
  getItsaplanErrorMessage,
  isItsaplanInvalidApiKeyError
} from './task-page/itsaplan/task-page-itsaplan-load-error'
import { ItsaplanIssueStateControl } from './itsaplan-issue-state-control'
import { ItsaplanIssueAssigneeControl } from './itsaplan-issue-assignee-control'
import { ItsaplanIssueComments } from './itsaplan-issue-comments'

type ItsaplanIssueWorkspaceProps = {
  issue: ItsaplanIssue
  backLabel: string
  onUse: (issue: ItsaplanIssue) => void
  onOpenIssue: (issue: ItsaplanIssue) => void
  onClose: () => void
  onReconnect: () => void
}

function SidebarField({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function ItsaplanIssueWorkspaceIssue({
  issue,
  backLabel,
  onUse,
  onOpenIssue,
  onClose,
  onReconnect
}: ItsaplanIssueWorkspaceProps): React.JSX.Element {
  const t = useTranslate()
  const detail = useAppStore((s) => s.itsaplanIssueDetails[issue.id])
  const metadata = useAppStore((s) => s.itsaplanProjectMetadata[issue.projectRef])
  const loadItsaplanIssueDetail = useAppStore((s) => s.loadItsaplanIssueDetail)
  const loadItsaplanProjectMetadata = useAppStore((s) => s.loadItsaplanProjectMetadata)
  const [detailLoading, setDetailLoading] = useState(true)
  const [detailError, setDetailError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void loadItsaplanIssueDetail(issue.id, { projectRef: issue.projectRef })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDetailError(getItsaplanErrorMessage(error))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [issue.id, issue.projectRef, loadItsaplanIssueDetail])
  useEffect(() => {
    if (metadata) {
      return
    }
    void loadItsaplanProjectMetadata(issue.projectRef).catch(() => {
      console.warn("[ItsaplanIssueWorkspace] Failed to load It's a Plan project metadata")
    })
  }, [issue.projectRef, loadItsaplanProjectMetadata, metadata])
  const displayed: ItsaplanIssue = detail ?? issue
  const description = displayed.description.trim()
  const noneLabel = t('taskProviders.itsaplan.none', 'None')
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
      <header className="flex h-[61px] flex-none items-center justify-between gap-4 border-b border-border/60 px-5">
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="-ml-2 shrink-0"
            aria-label={backLabel}
          >
            <ChevronLeft className="size-4" />
            {backLabel}
          </Button>
          <ItsaplanIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-mono">{displayed.identifier}</span>
          <span className="min-w-0 truncate font-medium text-foreground">{displayed.title}</span>
          {detailLoading ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={(event) => openAppHttpLink(displayed.url, { event })}
                aria-label={t('taskProviders.itsaplan.openInBrowser', 'Open in browser')}
              >
                <ExternalLink className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('taskProviders.itsaplan.openInBrowser', 'Open in browser')}
            </TooltipContent>
          </Tooltip>
          <Button
            type="button"
            size="sm"
            onClick={() => onUse(displayed)}
            className="whitespace-nowrap"
          >
            {t('auto.components.LinearIssueWorkspace.e1e0a9bca9', 'Start workspace')}
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        <div className="mx-auto grid w-full grid-cols-1 gap-10 px-7 py-10 lg:grid-cols-[minmax(0,1fr)_280px] lg:px-10 xl:px-12">
          <main className="min-w-0">
            {detailError && isItsaplanInvalidApiKeyError(detailError) ? (
              <div className="mb-6 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <span>
                  {t('taskProviders.itsaplan.invalidKeyTitle', 'API key invalid, reconnect')}
                </span>
                <Button variant="outline" size="xs" onClick={onReconnect}>
                  {t('taskProviders.itsaplan.reconnect', 'Reconnect')}
                </Button>
              </div>
            ) : detailError ? (
              <div className="mb-6 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {detailError}
              </div>
            ) : null}
            <h1 className="text-2xl font-semibold text-foreground">{displayed.title}</h1>
            <div className="mt-6">
              {description ? (
                <CommentMarkdown content={description} variant="document" />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('taskProviders.itsaplan.noDescription', 'No description.')}
                </p>
              )}
            </div>
            {detail && detail.subtasks.length > 0 ? (
              <section className="mt-10">
                <h2 className="mb-3 text-sm font-semibold text-foreground">
                  {t('taskProviders.itsaplan.subtasks', 'Subtasks')}
                </h2>
                <div className="divide-y divide-border/50 rounded-md border border-border/50">
                  {detail.subtasks.map((subtask) => (
                    <button
                      key={subtask.id}
                      type="button"
                      onClick={() => onOpenIssue(subtask)}
                      className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <span className="shrink-0 font-mono text-[12px] text-muted-foreground">
                        {subtask.identifier}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                        {subtask.title}
                      </span>
                      <ItsaplanStatePill state={subtask.state} />
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            {detail ? (
              <ItsaplanIssueComments
                issueId={issue.id}
                projectRef={issue.projectRef}
                comments={detail.comments}
              />
            ) : null}
          </main>
          <aside className="flex min-w-0 flex-col gap-5">
            <SidebarField label={t('auto.components.TaskPage.154b0fa623', 'Status')}>
              <ItsaplanIssueStateControl issue={displayed} columns={metadata?.columns ?? []} />
            </SidebarField>
            <SidebarField label={t('auto.components.TaskPage.d2a876ca53', 'Assignee')}>
              <ItsaplanIssueAssigneeControl issue={displayed} members={metadata?.members ?? []} />
            </SidebarField>
            <SidebarField label={t('taskProviders.itsaplan.delegate', 'Delegate')}>
              <span className="text-sm text-foreground">
                {displayed.delegate?.name ?? noneLabel}
              </span>
            </SidebarField>
            <SidebarField label={t('auto.components.TaskPage.c8d5bec5f7', 'Priority')}>
              <span className="text-sm text-foreground">{displayed.priority ?? noneLabel}</span>
            </SidebarField>
            <SidebarField label={t('auto.components.TaskPage.d0ca4aa1d0', 'Labels')}>
              {displayed.labels.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {displayed.labels.map((label) => (
                    <span
                      key={label.id}
                      className="max-w-full truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    >
                      {label.name}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">{noneLabel}</span>
              )}
            </SidebarField>
          </aside>
        </div>
      </div>
    </div>
  )
}

export default function ItsaplanIssueWorkspace(
  props: ItsaplanIssueWorkspaceProps
): React.JSX.Element {
  // Keyed so a subtask hop resets the per-issue load state.
  return <ItsaplanIssueWorkspaceIssue key={props.issue.id} {...props} />
}
