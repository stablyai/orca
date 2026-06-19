import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, LoaderCircle, X } from 'lucide-react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'

import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { GlpiIcon } from '@/components/icons/GlpiIcon'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { GlpiFollowup, GlpiTicket, GlpiTicketStatus } from '../../../shared/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { buildGlpiTicketActions } from './glpi-ticket-workspace-actions'
import {
  formatGlpiRelativeTime,
  GlpiTicketFollowupComposer,
  GlpiTicketFollowups
} from './glpi-ticket-followups'
import {
  getGlpiScaleLabel,
  getGlpiStatusLabel,
  getGlpiTypeLabel,
  GlpiTicketStatusControl
} from './glpi-ticket-status-control'

type GlpiTicketWorkspaceProps = {
  ticket: GlpiTicket
  onUse: (ticket: GlpiTicket) => void
  onClose: () => void
  sourceContext?: TaskSourceContext | null
}

export default function GlpiTicketWorkspace({
  ticket,
  onUse,
  onClose,
  sourceContext
}: GlpiTicketWorkspaceProps): React.JSX.Element {
  const fetchGlpiTicket = useAppStore((s) => s.fetchGlpiTicket)
  const fetchGlpiFollowups = useAppStore((s) => s.fetchGlpiFollowups)
  const addGlpiFollowupComment = useAppStore((s) => s.addGlpiFollowupComment)
  const updateGlpiTicketDetail = useAppStore((s) => s.updateGlpiTicketDetail)

  const [fullTicket, setFullTicket] = useState<GlpiTicket>(ticket)
  const [ticketLoading, setTicketLoading] = useState(false)
  const [followups, setFollowups] = useState<GlpiFollowup[]>([])
  const [followupsLoading, setFollowupsLoading] = useState(false)
  const [followupsError, setFollowupsError] = useState<string | null>(null)
  const [statusPending, setStatusPending] = useState(false)
  const [followupDraft, setFollowupDraft] = useState('')
  const [followupSubmitting, setFollowupSubmitting] = useState(false)
  const requestIdRef = useRef(0)

  const displayed = fullTicket
  const serverId = displayed.serverId ?? null
  const options = useMemo(() => ({ sourceContext }), [sourceContext])

  const loadFollowups = useCallback(
    async (id: number, requestId: number): Promise<void> => {
      setFollowupsLoading(true)
      setFollowupsError(null)
      try {
        const fetched = await fetchGlpiFollowups(id, serverId, options)
        if (requestId !== requestIdRef.current) {
          return
        }
        setFollowups(fetched)
      } catch (error) {
        if (requestId === requestIdRef.current) {
          setFollowupsError(
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.GlpiTicketWorkspace.62fd2e0719',
                  'Failed to load followups.'
                )
          )
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setFollowupsLoading(false)
        }
      }
    },
    [fetchGlpiFollowups, options, serverId]
  )

  useEffect(() => {
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    setFullTicket(ticket)
    setFollowups([])
    setFollowupsError(null)
    setFollowupDraft('')
    setTicketLoading(true)

    void fetchGlpiTicket(ticket.id, ticket.serverId ?? null, { sourceContext })
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (result) {
          setFullTicket(result)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setTicketLoading(false)
        }
      })

    void loadFollowups(ticket.id, requestId)
  }, [ticket, fetchGlpiTicket, loadFollowups, sourceContext])

  const refreshTicket = useCallback(
    async (id: number, server: string | null, requestId: number): Promise<void> => {
      const latest = await fetchGlpiTicket(id, server, options).catch(() => null)
      // Why: ignore the result if the user switched tickets mid-flight.
      if (latest && requestId === requestIdRef.current && latest.id === id) {
        setFullTicket(latest)
      }
    },
    [fetchGlpiTicket, options]
  )

  const handleStatusChange = useCallback(
    async (next: GlpiTicketStatus): Promise<void> => {
      if (statusPending || next === displayed.status) {
        return
      }
      const requestId = requestIdRef.current
      const ticketId = displayed.id
      const server = serverId
      setStatusPending(true)
      const previous = displayed.status
      // Optimistic flip so the badge updates before the round-trip resolves.
      setFullTicket((current) => ({ ...current, status: next }))
      try {
        const result = await updateGlpiTicketDetail(ticketId, { status: next }, server, options)
        if (!result.ok) {
          throw new Error(result.error)
        }
        await refreshTicket(ticketId, server, requestId)
      } catch (error) {
        // Why: only roll back if the same ticket is still selected.
        if (requestId === requestIdRef.current && displayed.id === ticketId) {
          setFullTicket((current) => ({ ...current, status: previous }))
        }
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.GlpiTicketWorkspace.375ad44a42',
                'Failed to update ticket.'
              )
        )
      } finally {
        if (requestId === requestIdRef.current) {
          setStatusPending(false)
        }
      }
    },
    [
      displayed.id,
      displayed.status,
      options,
      refreshTicket,
      serverId,
      statusPending,
      updateGlpiTicketDetail
    ]
  )

  const handleSubmitFollowup = useCallback(async (): Promise<void> => {
    if (followupSubmitting) {
      return
    }
    const content = followupDraft.trim()
    if (!content) {
      return
    }
    const requestId = requestIdRef.current
    const ticketId = displayed.id
    const server = serverId
    setFollowupSubmitting(true)
    try {
      const result = await addGlpiFollowupComment(ticketId, content, server, options)
      if (!result.ok) {
        throw new Error(result.error)
      }
      // Why: don't reset the draft or reload if the user switched tickets.
      if (requestId === requestIdRef.current) {
        setFollowupDraft('')
        await loadFollowups(ticketId, requestId)
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.GlpiTicketWorkspace.ac04e56c2f', 'Failed to add followup.')
      )
    } finally {
      if (requestId === requestIdRef.current) {
        setFollowupSubmitting(false)
      }
    }
  }, [
    addGlpiFollowupComment,
    displayed.id,
    followupDraft,
    followupSubmitting,
    loadFollowups,
    options,
    serverId
  ])

  const actionItems = useMemo(() => buildGlpiTicketActions(displayed), [displayed])

  const requesterLabel =
    displayed.requester?.fullName ??
    displayed.requester?.login ??
    translate('auto.components.GlpiTicketWorkspace.70133b524a', 'No requester')
  const assigneeLabel =
    displayed.assignees.length > 0
      ? displayed.assignees.map((user) => user.fullName ?? user.login).join(', ')
      : translate('auto.components.GlpiTicketWorkspace.21a015b029', 'Unassigned')

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,780px)] p-0 sm:max-w-[780px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>{displayed.title}</SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.GlpiTicketWorkspace.d4121e691b',
              'Preview, update, and start work from the selected ticket.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
          <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
            {/* Why: the drawer docks right, where Orca's window controls live on
                Windows. Keep the action buttons on the left (clear of those, and
                of macOS traffic lights which sit outside the drawer). */}
            <div className="mb-2 flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    onClick={onClose}
                    aria-label={translate(
                      'auto.components.GlpiTicketWorkspace.be1acc0de5',
                      'Close GLPI ticket preview'
                    )}
                  >
                    <X className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate('auto.components.GlpiTicketWorkspace.2bcf18562f', 'Close')}
                </TooltipContent>
              </Tooltip>
              <Button
                onClick={() => onUse(displayed)}
                className="hidden gap-2 sm:inline-flex"
                size="sm"
              >
                {translate('auto.components.GlpiTicketWorkspace.656b9da353', 'Start workspace')}
                <ArrowRight className="size-4" />
              </Button>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                <span className="font-mono">#{displayed.id}</span>
                {displayed.serverName ? <span>{displayed.serverName}</span> : null}
                <span>{getGlpiTypeLabel(displayed.type)}</span>
                <span>{formatGlpiRelativeTime(displayed.updatedAt)}</span>
                {ticketLoading ? <LoaderCircle className="size-3 animate-spin" /> : null}
              </div>
              <h2 className="mt-1 text-[20px] font-semibold leading-tight text-foreground">
                {displayed.title}
              </h2>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
            <GlpiTicketStatusControl
              status={displayed.status}
              pending={statusPending}
              onChange={(next) => void handleStatusChange(next)}
            />
            <span className="text-[11px] text-muted-foreground">
              {translate('auto.components.GlpiTicketWorkspace.e9d3e09d8a', 'Urgency')}:{' '}
              {getGlpiScaleLabel(displayed.urgency)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {translate('auto.components.GlpiTicketWorkspace.475506bad9', 'Priority')}:{' '}
              {getGlpiScaleLabel(displayed.priority)}
            </span>
            {displayed.category ? (
              <span className="text-[11px] text-muted-foreground">{displayed.category}</span>
            ) : null}
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_228px]">
            <div className="min-h-0 overflow-y-auto scrollbar-sleek">
              <section className="border-b border-border/40 px-4 py-4">
                <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <GlpiIcon className="size-3 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground">
                    {getGlpiStatusLabel(displayed.status)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {requesterLabel} · {assigneeLabel}
                  </span>
                </div>
                {displayed.content?.trim() ? (
                  // Why: GLPI ticket bodies are HTML; CommentMarkdown sanitizes
                  // via rehype-sanitize before rendering — never raw injection.
                  <CommentMarkdown
                    content={displayed.content}
                    variant="document"
                    className="text-[14px] leading-relaxed"
                  />
                ) : (
                  <p className="text-sm italic text-muted-foreground">
                    {translate(
                      'auto.components.GlpiTicketWorkspace.5ba820459a',
                      'No description provided.'
                    )}
                  </p>
                )}
              </section>

              <GlpiTicketFollowups
                followups={followups}
                loading={followupsLoading}
                error={followupsError}
                onRetry={() => void loadFollowups(displayed.id, requestIdRef.current)}
              />
            </div>

            <aside className="border-t border-border/50 bg-muted/20 px-3 py-3 xl:border-l xl:border-t-0">
              <Button
                onClick={() => onUse(displayed)}
                className="mb-3 w-full justify-center gap-2 sm:hidden"
              >
                {translate('auto.components.GlpiTicketWorkspace.656b9da353', 'Start workspace')}
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

          <GlpiTicketFollowupComposer
            value={followupDraft}
            submitting={followupSubmitting}
            onChange={setFollowupDraft}
            onSubmit={() => void handleSubmitFollowup()}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
