import React, { useEffect, useRef, useState } from 'react'
import { ArrowRight, ExternalLink, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { VisuallyHidden } from 'radix-ui'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import type { LinearIssue } from '../../../shared/types'

function LinearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

const PRIORITY_LABELS: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
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

function getStateTone(stateType: string): string {
  switch (stateType) {
    case 'completed':
      return 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-300'
    case 'canceled':
    case 'cancelled':
      return 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300'
    case 'started':
    case 'unstarted':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
    case 'backlog':
      return 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300'
    default:
      return 'border-border/50 bg-muted/30 text-muted-foreground'
  }
}

type LinearItemDrawerProps = {
  issue: LinearIssue | null
  onUse: (issue: LinearIssue) => void
  onClose: () => void
}

export default function LinearItemDrawer({
  issue,
  onUse,
  onClose
}: LinearItemDrawerProps): React.JSX.Element {
  const [fullIssue, setFullIssue] = useState<LinearIssue | null>(null)
  const requestIdRef = useRef(0)

  // Why: the list view may not include the full description. Re-fetch
  // the issue by ID to get the complete body for the drawer.
  useEffect(() => {
    if (!issue) {
      setFullIssue(null)
      return
    }
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    setFullIssue(issue)

    window.api.linear
      .getIssue({ id: issue.id })
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (result) {
          setFullIssue(result as LinearIssue)
        }
      })
      .catch(() => {})
  }, [issue])

  // Why: same pointer-events fix as GitHubItemDrawer — Radix may leave
  // pointer-events: none on body when overlays transition.
  useEffect(() => {
    if (!issue) {
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
  }, [issue])

  const displayed = fullIssue ?? issue

  return (
    <Sheet open={issue !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full p-0 sm:max-w-[640px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>{displayed?.title ?? 'Linear issue'}</SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>Read-only preview of the selected Linear issue.</SheetDescription>
        </VisuallyHidden.Root>

        {displayed && (
          <div className="flex h-full min-h-0 flex-col">
            {/* Header */}
            <div className="flex-none border-b border-border/60 px-4 py-3">
              <div className="flex items-start gap-2">
                <LinearIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                        getStateTone(displayed.state.type)
                      )}
                    >
                      {displayed.state.name}
                    </span>
                    <span className="font-mono text-[12px] text-muted-foreground">
                      {displayed.identifier}
                    </span>
                  </div>
                  <h2 className="mt-1 text-[15px] font-semibold leading-tight text-foreground">
                    {displayed.title}
                  </h2>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    {displayed.assignee && <span>{displayed.assignee.displayName}</span>}
                    <span>· {displayed.team.name}</span>
                    <span>· {formatRelativeTime(displayed.updatedAt)}</span>
                    {displayed.priority > 0 && (
                      <span>
                        · {PRIORITY_LABELS[displayed.priority] ?? `P${displayed.priority}`}
                      </span>
                    )}
                  </div>
                  {displayed.labels.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {displayed.labels.map((label) => (
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
                        onClick={() => window.api.shell.openUrl(displayed.url)}
                        aria-label="Open on Linear"
                      >
                        <ExternalLink className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      Open on Linear
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

            {/* Body */}
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
              <div className="px-4 py-4">
                {displayed.description?.trim() ? (
                  <CommentMarkdown
                    content={displayed.description}
                    className="text-[14px] leading-relaxed"
                  />
                ) : (
                  <span className="italic text-muted-foreground">No description provided.</span>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="flex-none border-t border-border/60 bg-background/40 px-4 py-3">
              <Button
                onClick={() => onUse(displayed)}
                className="w-full justify-center gap-2"
                aria-label="Start workspace from issue"
              >
                Start workspace from issue
                <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
