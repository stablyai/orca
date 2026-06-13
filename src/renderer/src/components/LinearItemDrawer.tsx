/* eslint-disable max-lines -- Why: the Linear drawer co-locates read-only preview, edit controls, and comment input so the full issue surface stays in one file. */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: Linear drawer state hydrates full issue details and comments from provider IPC for the selected issue. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  ChevronDown,
  ExternalLink,
  Gauge,
  LoaderCircle,
  Send,
  Tag,
  UserRound,
  X
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LinearIssueTextEditor } from '@/components/LinearIssueTextEditor'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { VisuallyHidden } from 'radix-ui'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { getScreenSubmitShortcutLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  useTeamStates,
  useTeamLabels,
  useTeamMembers,
  useImmediateMutation
} from '@/hooks/useIssueMetadata'
import {
  getLinearStateMarkerStyle,
  getLinearStatePillStyle
} from '@/components/linear-state-pill-style'
import { LinearPriorityIcon } from '@/components/linear-priority-icon'
import type { LinearIssue, LinearComment } from '../../../shared/types'
import {
  linearAddIssueComment,
  linearGetIssue,
  linearIssueComments,
  linearUpdateIssue
} from '@/runtime/runtime-linear-client'
import { translate } from '@/i18n/i18n'

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

const LINEAR_EDIT_CHIP_CLASS =
  'inline-flex h-6 min-w-0 max-w-[14rem] cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-background/70 px-2.5 text-[11px] font-medium leading-none text-muted-foreground shadow-xs transition-[background-color,border-color,color,box-shadow] hover:border-border hover:bg-accent hover:text-accent-foreground hover:[--linear-state-pill-current-background:var(--linear-state-pill-hover-background)] hover:[--linear-state-pill-current-border:var(--linear-state-pill-hover-border)] hover:[--linear-state-pill-current-foreground:var(--linear-state-pill-hover-foreground)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-80'

const LINEAR_EDIT_MENU_ITEM_CLASS =
  'flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent'

const LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS =
  'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent'

const LINEAR_ESTIMATE_PRESETS = [1, 2, 3, 5, 8] as const

export function formatLinearEstimateLabel(estimate: number | null | undefined): string {
  return estimate === null || estimate === undefined ? 'Set estimate' : `Estimate ${estimate}`
}

function formatLinearEstimateInput(estimate: number | null | undefined): string {
  return estimate === null || estimate === undefined ? '' : String(estimate)
}

function LinearEditChipAdornment({
  loading,
  pending
}: {
  loading?: boolean
  pending?: boolean
}): React.JSX.Element {
  if (loading || pending) {
    return <LoaderCircle className="size-3 shrink-0 animate-spin opacity-70" />
  }

  return <ChevronDown className="size-3 shrink-0 opacity-55" />
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

type LinearItemDrawerProps = {
  issue: LinearIssue | null
  onUse: (issue: LinearIssue) => void
  onClose: () => void
}

export type LinearEditState = {
  state: LinearIssue['state']
  priority: number
  estimate: number | null | undefined
  assignee: LinearIssue['assignee']
  labelIds: string[]
  labels: string[]
}

type EditSectionProps = {
  issue: LinearIssue
  editState: LinearEditState
  onEditStateChange: (patch: Partial<LinearEditState>) => void
  layout?: 'chips' | 'properties'
}

export function LinearIssueEditSection({
  issue,
  editState,
  onEditStateChange,
  layout = 'chips'
}: EditSectionProps): React.JSX.Element {
  const [labelPopoverOpen, setLabelPopoverOpen] = useState(false)
  const [estimatePopoverOpen, setEstimatePopoverOpen] = useState(false)
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const settings = useAppStore((s) => s.settings)
  const { isPending, run } = useImmediateMutation()

  const {
    state: localState,
    priority: localPriority,
    estimate: localEstimate,
    assignee: localAssignee,
    labelIds: localLabelIds,
    labels: localLabels
  } = editState
  const [estimateInput, setEstimateInput] = useState(() => formatLinearEstimateInput(localEstimate))

  const teamId = issue.team?.id || null
  const states = useTeamStates(teamId, settings, issue.workspaceId)
  const labels = useTeamLabels(teamId, settings, issue.workspaceId)
  const members = useTeamMembers(teamId, settings, issue.workspaceId)

  const handleEstimatePopoverOpenChange = useCallback(
    (open: boolean) => {
      setEstimatePopoverOpen(open)
      if (open) {
        setEstimateInput(formatLinearEstimateInput(localEstimate))
      }
    },
    [localEstimate]
  )

  const handleStateChange = useCallback(
    (stateId: string) => {
      const newState = states.data.find((s) => s.id === stateId)
      if (!newState) {
        return
      }

      const prevState = localState
      const stateValue = { name: newState.name, type: newState.type, color: newState.color }

      run('state', {
        mutate: () => linearUpdateIssue(settings, issue.id, { stateId }, issue.workspaceId),
        onOptimistic: () => {
          onEditStateChange({ state: stateValue })
          patchLinearIssue(issue.id, { state: stateValue })
        },
        onRevert: () => {
          onEditStateChange({ state: prevState })
          patchLinearIssue(issue.id, { state: prevState })
        },
        onSuccess: () => {
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        onError: (err) => toast.error(err)
      })
    },
    [
      issue.id,
      issue.workspaceId,
      localState,
      settings,
      states.data,
      patchLinearIssue,
      run,
      onEditStateChange
    ]
  )

  const handlePriorityChange = useCallback(
    (value: string) => {
      const priority = parseInt(value, 10)
      const prevPriority = localPriority
      run('priority', {
        mutate: () => linearUpdateIssue(settings, issue.id, { priority }, issue.workspaceId),
        onOptimistic: () => {
          onEditStateChange({ priority })
          patchLinearIssue(issue.id, { priority })
        },
        onRevert: () => {
          onEditStateChange({ priority: prevPriority })
          patchLinearIssue(issue.id, { priority: prevPriority })
        },
        onSuccess: () => {
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        onError: (err) => toast.error(err)
      })
    },
    [issue.id, issue.workspaceId, localPriority, settings, patchLinearIssue, run, onEditStateChange]
  )

  const handleEstimateChange = useCallback(
    (estimate: number | null) => {
      const prevEstimate = localEstimate
      run('estimate', {
        mutate: () => linearUpdateIssue(settings, issue.id, { estimate }, issue.workspaceId),
        onOptimistic: () => {
          onEditStateChange({ estimate })
          patchLinearIssue(issue.id, { estimate })
          setEstimatePopoverOpen(false)
        },
        onRevert: () => {
          onEditStateChange({ estimate: prevEstimate })
          patchLinearIssue(issue.id, { estimate: prevEstimate })
        },
        onSuccess: () => {
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        onError: (err) => toast.error(err)
      })
    },
    [issue.id, issue.workspaceId, localEstimate, settings, patchLinearIssue, run, onEditStateChange]
  )

  const handleEstimateSubmit = useCallback(() => {
    const trimmed = estimateInput.trim()
    if (!trimmed) {
      handleEstimateChange(null)
      return
    }

    const estimate = Number(trimmed)
    if (!Number.isInteger(estimate) || estimate < 0) {
      toast.error(
        translate(
          'auto.components.LinearItemDrawer.0be31fef8e',
          'Estimate must be a non-negative integer'
        )
      )
      return
    }

    handleEstimateChange(estimate)
  }, [estimateInput, handleEstimateChange])

  const handleAssigneeChange = useCallback(
    (memberId: string) => {
      const assigneeId = memberId === '__unassign__' ? null : memberId
      const member = members.data.find((m) => m.id === memberId)
      const prevAssignee = localAssignee
      const newAssignee = member
        ? { id: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl }
        : undefined
      run('assignee', {
        mutate: () => linearUpdateIssue(settings, issue.id, { assigneeId }, issue.workspaceId),
        onOptimistic: () => {
          onEditStateChange({ assignee: newAssignee })
          patchLinearIssue(issue.id, { assignee: newAssignee })
        },
        onRevert: () => {
          onEditStateChange({ assignee: prevAssignee })
          patchLinearIssue(issue.id, { assignee: prevAssignee })
        },
        onSuccess: () => {
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        onError: (err) => toast.error(err)
      })
    },
    [
      issue.id,
      issue.workspaceId,
      localAssignee,
      settings,
      members.data,
      patchLinearIssue,
      run,
      onEditStateChange
    ]
  )

  const handleLabelToggle = useCallback(
    (labelId: string) => {
      const prevLabelIds = localLabelIds
      const prevLabels = localLabels
      const isRemoving = prevLabelIds.includes(labelId)
      const newLabelIds = isRemoving
        ? prevLabelIds.filter((id) => id !== labelId)
        : [...prevLabelIds, labelId]
      const newLabels = newLabelIds
        .map((id) => labels.data.find((l) => l.id === id)?.name)
        .filter((n): n is string => !!n)

      run('labels', {
        mutate: () =>
          linearUpdateIssue(settings, issue.id, { labelIds: newLabelIds }, issue.workspaceId),
        onOptimistic: () => {
          onEditStateChange({ labelIds: newLabelIds, labels: newLabels })
          patchLinearIssue(issue.id, { labelIds: newLabelIds, labels: newLabels })
        },
        onRevert: () => {
          onEditStateChange({ labelIds: prevLabelIds, labels: prevLabels })
          patchLinearIssue(issue.id, { labelIds: prevLabelIds, labels: prevLabels })
        },
        onSuccess: () => {
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        onError: (err) => toast.error(err)
      })
    },
    [
      issue.id,
      issue.workspaceId,
      localLabelIds,
      localLabels,
      settings,
      labels.data,
      patchLinearIssue,
      run,
      onEditStateChange
    ]
  )

  const currentStateId = states.data.find(
    (s) => s.name === localState.name && s.type === localState.type
  )?.id
  const statePending = isPending('state')
  const priorityPending = isPending('priority')
  const estimatePending = isPending('estimate')
  const assigneePending = isPending('assignee')
  const labelsPending = isPending('labels')
  const labelSummary =
    localLabels.length === 0
      ? '+ Label'
      : localLabels.length === 1
        ? localLabels[0]
        : `${localLabels[0]} +${localLabels.length - 1}`

  const checkIcon = (
    <svg className="size-2.5" viewBox="0 0 12 12" fill="none">
      <path
        d="M2 6l3 3 5-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )

  if (layout === 'properties') {
    const propertyRowClass =
      'flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-80'
    const propertyIconClass = 'size-4 shrink-0 text-muted-foreground'

    return (
      <div className="space-y-3">
        <section className="rounded-xl border border-border/60 bg-card text-card-foreground shadow-xs">
          <div className="flex h-10 items-center gap-1 border-b border-border/50 px-4 text-sm font-medium text-muted-foreground">
            <span>{translate('auto.components.LinearItemDrawer.dd304de85a', 'Properties')}</span>
            <ChevronDown className="size-3.5" />
          </div>
          <div className="space-y-1 p-3">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={statePending}
                  className={propertyRowClass}
                  aria-busy={statePending || states.loading}
                >
                  <span
                    className="inline-block size-2.5 shrink-0 rounded-full"
                    style={getLinearStateMarkerStyle(localState.color)}
                  />
                  <span className="min-w-0 flex-1 truncate">{localState.name}</span>
                  <LinearEditChipAdornment loading={states.loading} pending={statePending} />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="popover-scroll-content scrollbar-sleek w-48 p-1"
                align="start"
              >
                {states.error ? (
                  <div className="px-2 py-3 text-center text-[12px] text-destructive">
                    {states.error}
                  </div>
                ) : states.loading ? (
                  <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
                    <LoaderCircle className="size-3 animate-spin" />
                    {translate('auto.components.LinearItemDrawer.59b6cd3706', 'Loading states')}
                  </div>
                ) : states.data.length > 0 ? (
                  <div>
                    {states.data.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => handleStateChange(s.id)}
                        className={cn(
                          LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS,
                          currentStateId === s.id && 'bg-accent/50'
                        )}
                      >
                        <span
                          className="inline-block size-2 rounded-full"
                          style={{ backgroundColor: s.color }}
                        />
                        {s.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                    {translate('auto.components.LinearItemDrawer.780ea6ed89', 'No states found')}
                  </div>
                )}
              </PopoverContent>
            </Popover>

            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={priorityPending}
                  className={propertyRowClass}
                  aria-busy={priorityPending}
                >
                  <LinearPriorityIcon priority={localPriority} />
                  <span className="min-w-0 flex-1 truncate">
                    {PRIORITY_LABELS[localPriority] ?? `P${localPriority}`}
                  </span>
                  <LinearEditChipAdornment pending={priorityPending} />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-36 p-1" align="start">
                {[0, 1, 2, 3, 4].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => handlePriorityChange(String(p))}
                    className={cn(
                      LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS,
                      localPriority === p && 'bg-accent/50'
                    )}
                  >
                    <LinearPriorityIcon priority={p} />
                    {PRIORITY_LABELS[p]}
                  </button>
                ))}
              </PopoverContent>
            </Popover>

            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={assigneePending}
                  className={propertyRowClass}
                  aria-busy={assigneePending || members.loading}
                >
                  {localAssignee?.avatarUrl ? (
                    <img
                      src={localAssignee.avatarUrl}
                      alt=""
                      className="size-4 shrink-0 rounded-full"
                    />
                  ) : (
                    <UserRound className={propertyIconClass} />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {localAssignee
                      ? localAssignee.displayName
                      : translate('auto.components.LinearItemDrawer.866316f22c', 'Unassigned')}
                  </span>
                  <LinearEditChipAdornment loading={members.loading} pending={assigneePending} />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="popover-scroll-content scrollbar-sleek w-48 p-1"
                align="start"
              >
                <div>
                  <button
                    type="button"
                    onClick={() => handleAssigneeChange('__unassign__')}
                    className={cn(LINEAR_EDIT_MENU_ITEM_CLASS, !localAssignee && 'bg-accent/50')}
                  >
                    {translate('auto.components.LinearItemDrawer.866316f22c', 'Unassigned')}
                  </button>
                  {members.error ? (
                    <div className="px-2 py-3 text-center text-[12px] text-destructive">
                      {members.error}
                    </div>
                  ) : members.loading ? (
                    <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
                      <LoaderCircle className="size-3 animate-spin" />
                      {translate('auto.components.LinearItemDrawer.b2376d0179', 'Loading members')}
                    </div>
                  ) : (
                    members.data.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => handleAssigneeChange(m.id)}
                        className={cn(
                          LINEAR_EDIT_MENU_ITEM_CLASS,
                          localAssignee?.id === m.id && 'bg-accent/50'
                        )}
                      >
                        {m.displayName}
                      </button>
                    ))
                  )}
                </div>
              </PopoverContent>
            </Popover>

            <Popover open={estimatePopoverOpen} onOpenChange={handleEstimatePopoverOpenChange}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={estimatePending}
                  className={propertyRowClass}
                  aria-busy={estimatePending}
                >
                  <Gauge className={propertyIconClass} />
                  <span className="min-w-0 flex-1 truncate">
                    {formatLinearEstimateLabel(localEstimate)}
                  </span>
                  <LinearEditChipAdornment pending={estimatePending} />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-3" align="start">
                <div className="space-y-3">
                  <div className="grid grid-cols-5 gap-1.5">
                    {LINEAR_ESTIMATE_PRESETS.map((estimate) => (
                      <button
                        key={estimate}
                        type="button"
                        onClick={() => handleEstimateChange(estimate)}
                        className={cn(
                          'flex h-8 items-center justify-center rounded-md border border-border text-sm hover:bg-accent',
                          localEstimate === estimate && 'border-primary bg-accent text-foreground'
                        )}
                      >
                        {estimate}
                      </button>
                    ))}
                  </div>
                  <Input
                    value={estimateInput}
                    onChange={(event) => setEstimateInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        handleEstimateSubmit()
                      }
                    }}
                    inputMode="numeric"
                    placeholder={translate(
                      'auto.components.LinearItemDrawer.fbb90300e2',
                      'Custom estimate'
                    )}
                    className="h-8 text-sm"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEstimateChange(null)}
                    >
                      {translate('auto.components.LinearItemDrawer.ceeb8c6153', 'Clear')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleEstimateSubmit}
                      disabled={estimatePending}
                    >
                      {estimatePending ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                      {translate('auto.components.LinearItemDrawer.b5675b0694', 'Save')}
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </section>

        <section className="rounded-xl border border-border/60 bg-card text-card-foreground shadow-xs">
          <div className="flex h-10 items-center gap-1 border-b border-border/50 px-4 text-sm font-medium text-muted-foreground">
            <span>{translate('auto.components.LinearItemDrawer.64bfffc4dd', 'Labels')}</span>
            <ChevronDown className="size-3.5" />
          </div>
          <div className="p-3">
            <Popover open={labelPopoverOpen} onOpenChange={setLabelPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={labelsPending}
                  className={propertyRowClass}
                  aria-label={
                    localLabels.length
                      ? translate(
                          'auto.components.LinearItemDrawer.7f7b89b631',
                          'Labels: {{value0}}',
                          { value0: localLabels.join(', ') }
                        )
                      : translate('auto.components.LinearItemDrawer.23886c7eec', 'Add label')
                  }
                  aria-busy={labelsPending || labels.loading}
                >
                  <Tag className={propertyIconClass} />
                  <span className="min-w-0 flex-1 truncate">
                    {localLabels.length
                      ? labelSummary
                      : translate('auto.components.LinearItemDrawer.23886c7eec', 'Add label')}
                  </span>
                  <LinearEditChipAdornment loading={labels.loading} pending={labelsPending} />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="popover-scroll-content scrollbar-sleek w-52 p-1"
                align="start"
              >
                {labels.error ? (
                  <div className="px-2 py-3 text-center text-[12px] text-destructive">
                    {labels.error}
                  </div>
                ) : labels.loading ? (
                  <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
                    <LoaderCircle className="size-3 animate-spin" />
                    {translate('auto.components.LinearItemDrawer.cddd9b04a7', 'Loading labels')}
                  </div>
                ) : labels.data.length > 0 ? (
                  <div>
                    {labels.data.map((label) => (
                      <button
                        key={label.id}
                        type="button"
                        onClick={() => handleLabelToggle(label.id)}
                        className={LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS}
                      >
                        <span
                          className={cn(
                            'flex size-3.5 items-center justify-center rounded-sm border',
                            localLabelIds.includes(label.id)
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-input'
                          )}
                        >
                          {localLabelIds.includes(label.id) && checkIcon}
                        </span>
                        <span
                          className="inline-block size-2 rounded-full"
                          style={{ backgroundColor: label.color }}
                        />
                        {label.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                    {translate('auto.components.LinearItemDrawer.367f828482', 'No labels found')}
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
      {/* Status */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={statePending}
            className={LINEAR_EDIT_CHIP_CLASS}
            style={getLinearStatePillStyle(localState.color)}
            aria-busy={statePending || states.loading}
          >
            <span
              className="inline-block size-2 shrink-0 rounded-full"
              style={getLinearStateMarkerStyle(localState.color)}
            />
            <span className="truncate">{localState.name}</span>
            <LinearEditChipAdornment loading={states.loading} pending={statePending} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-48 p-1" align="start">
          {states.error ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">{states.error}</div>
          ) : states.loading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              {translate('auto.components.LinearItemDrawer.59b6cd3706', 'Loading states')}
            </div>
          ) : states.data.length > 0 ? (
            <div>
              {states.data.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleStateChange(s.id)}
                  className={cn(
                    LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS,
                    currentStateId === s.id && 'bg-accent/50'
                  )}
                >
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ backgroundColor: s.color }}
                  />
                  {s.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
              {translate('auto.components.LinearItemDrawer.780ea6ed89', 'No states found')}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Priority */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={priorityPending}
            className={LINEAR_EDIT_CHIP_CLASS}
            aria-busy={priorityPending}
          >
            <LinearPriorityIcon priority={localPriority} />
            <span className="truncate">
              {PRIORITY_LABELS[localPriority] ?? `P${localPriority}`}
            </span>
            <LinearEditChipAdornment pending={priorityPending} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-36 p-1" align="start">
          {[0, 1, 2, 3, 4].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => handlePriorityChange(String(p))}
              className={cn(
                LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS,
                localPriority === p && 'bg-accent/50'
              )}
            >
              <LinearPriorityIcon priority={p} />
              {PRIORITY_LABELS[p]}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Estimate */}
      <Popover open={estimatePopoverOpen} onOpenChange={handleEstimatePopoverOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={estimatePending}
            className={LINEAR_EDIT_CHIP_CLASS}
            aria-busy={estimatePending}
          >
            <span className="truncate">{formatLinearEstimateLabel(localEstimate)}</span>
            <LinearEditChipAdornment pending={estimatePending} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" align="start">
          <div className="space-y-3">
            <div className="grid grid-cols-5 gap-1.5">
              {LINEAR_ESTIMATE_PRESETS.map((estimate) => (
                <button
                  key={estimate}
                  type="button"
                  onClick={() => handleEstimateChange(estimate)}
                  className={cn(
                    'flex h-8 items-center justify-center rounded-md border border-border text-sm hover:bg-accent',
                    localEstimate === estimate && 'border-primary bg-accent text-foreground'
                  )}
                >
                  {estimate}
                </button>
              ))}
            </div>
            <Input
              value={estimateInput}
              onChange={(event) => setEstimateInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  handleEstimateSubmit()
                }
              }}
              inputMode="numeric"
              placeholder={translate(
                'auto.components.LinearItemDrawer.fbb90300e2',
                'Custom estimate'
              )}
              className="h-8 text-sm"
            />
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleEstimateChange(null)}
              >
                {translate('auto.components.LinearItemDrawer.ceeb8c6153', 'Clear')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleEstimateSubmit}
                disabled={estimatePending}
              >
                {estimatePending ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                {translate('auto.components.LinearItemDrawer.b5675b0694', 'Save')}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Assignee */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={assigneePending}
            className={LINEAR_EDIT_CHIP_CLASS}
            aria-busy={assigneePending || members.loading}
          >
            <span className="truncate">
              {localAssignee
                ? localAssignee.displayName
                : translate('auto.components.LinearItemDrawer.d71cd3003e', '+ Assignee')}
            </span>
            <LinearEditChipAdornment loading={members.loading} pending={assigneePending} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-48 p-1" align="start">
          <div>
            <button
              type="button"
              onClick={() => handleAssigneeChange('__unassign__')}
              className={cn(LINEAR_EDIT_MENU_ITEM_CLASS, !localAssignee && 'bg-accent/50')}
            >
              {translate('auto.components.LinearItemDrawer.866316f22c', 'Unassigned')}
            </button>
            {members.error ? (
              <div className="px-2 py-3 text-center text-[12px] text-destructive">
                {members.error}
              </div>
            ) : members.loading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" />
                {translate('auto.components.LinearItemDrawer.b2376d0179', 'Loading members')}
              </div>
            ) : (
              members.data.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => handleAssigneeChange(m.id)}
                  className={cn(
                    LINEAR_EDIT_MENU_ITEM_CLASS,
                    localAssignee?.id === m.id && 'bg-accent/50'
                  )}
                >
                  {m.displayName}
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Labels */}
      <Popover open={labelPopoverOpen} onOpenChange={setLabelPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={labelsPending}
            className={LINEAR_EDIT_CHIP_CLASS}
            aria-label={
              localLabels.length
                ? translate('auto.components.LinearItemDrawer.7f7b89b631', 'Labels: {{value0}}', {
                    value0: localLabels.join(', ')
                  })
                : translate('auto.components.LinearItemDrawer.23886c7eec', 'Add label')
            }
            aria-busy={labelsPending || labels.loading}
          >
            <span className="truncate">{labelSummary}</span>
            <LinearEditChipAdornment loading={labels.loading} pending={labelsPending} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-52 p-1" align="start">
          {labels.error ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">{labels.error}</div>
          ) : labels.loading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              {translate('auto.components.LinearItemDrawer.cddd9b04a7', 'Loading labels')}
            </div>
          ) : labels.data.length > 0 ? (
            <div>
              {labels.data.map((label) => (
                <button
                  key={label.id}
                  type="button"
                  onClick={() => handleLabelToggle(label.id)}
                  className={LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS}
                >
                  <span
                    className={cn(
                      'flex size-3.5 items-center justify-center rounded-sm border',
                      localLabelIds.includes(label.id)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input'
                    )}
                  >
                    {localLabelIds.includes(label.id) && checkIcon}
                  </span>
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  {label.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
              {translate('auto.components.LinearItemDrawer.367f828482', 'No labels found')}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

export type LinearLocalComment = { id: string; body: string; createdAt: string }

export function LinearIssueCommentFooter({
  issueId,
  workspaceId,
  onCommentAdded,
  variant = 'compact'
}: {
  issueId: string
  workspaceId?: string | null
  onCommentAdded: (comment: LinearLocalComment) => void
  variant?: 'compact' | 'linear-page'
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const submitShortcutLabel = getScreenSubmitShortcutLabel()
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mountedRef = useRef(true)

  const handleFooterRef = useCallback((node: HTMLDivElement | null): void => {
    // Why: comment submission can resolve after the footer unmounts; the root
    // ref keeps that completion from writing stale local state without an Effect.
    mountedRef.current = node !== null
  }, [])

  const autoGrow = useCallback(() => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`
  }, [])

  const handleSubmit = useCallback(async () => {
    const trimmed = body.trim()
    if (!trimmed) {
      return
    }
    setSubmitting(true)
    try {
      const result = await linearAddIssueComment(settings, issueId, trimmed, workspaceId)
      const typed = result as { ok: boolean; id?: string; error?: string }
      if (!mountedRef.current) {
        return
      }
      if (typed.ok) {
        setBody('')
        useAppStore.getState().recordFeatureInteraction('linear-tasks')
        onCommentAdded({
          id: typed.id ?? createBrowserUuid(),
          body: trimmed,
          createdAt: new Date().toISOString()
        })
      } else {
        toast.error(
          typed.error ??
            translate('auto.components.LinearItemDrawer.6ab35eafd5', 'Failed to add comment')
        )
      }
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate('auto.components.LinearItemDrawer.6ab35eafd5', 'Failed to add comment')
        )
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }, [body, issueId, onCommentAdded, settings, workspaceId])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isScreenSubmitShortcut(e)) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  if (variant === 'linear-page') {
    return (
      <div
        ref={handleFooterRef}
        className="rounded-xl border border-border/70 bg-background shadow-xs"
      >
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => {
            setBody(e.target.value)
            autoGrow()
          }}
          onKeyDown={handleKeyDown}
          placeholder={translate(
            'auto.components.LinearItemDrawer.2820f0f0f0',
            'Leave a comment...'
          )}
          rows={3}
          className="scrollbar-sleek min-h-24 max-h-40 w-full resize-none overflow-y-auto rounded-t-xl bg-transparent px-5 py-4 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
        />
        <div className="flex items-center justify-between px-4 pb-3">
          <span className="text-[11px] text-muted-foreground">
            {submitShortcutLabel !== 'Unassigned'
              ? translate('auto.components.LinearItemDrawer.fda549766e', '{{value0}} to comment', {
                  value0: submitShortcutLabel
                })
              : ''}
          </span>
          <Button
            size="icon-sm"
            onClick={handleSubmit}
            disabled={!body.trim() || submitting}
            aria-label={translate('auto.components.LinearItemDrawer.d369841269', 'Send comment')}
          >
            {submitting ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={handleFooterRef}
      className="flex items-end gap-2 border-t border-border/60 bg-background/40 px-4 py-3"
    >
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          autoGrow()
        }}
        onKeyDown={handleKeyDown}
        placeholder={translate('auto.components.LinearItemDrawer.2fcff829a8', 'Add a comment…')}
        rows={1}
        className="scrollbar-sleek min-h-[32px] max-h-[96px] flex-1 resize-none overflow-y-auto rounded-md border border-input bg-transparent px-3 py-2 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <Button
        size="icon"
        onClick={handleSubmit}
        disabled={!body.trim() || submitting}
        className="size-8 shrink-0"
        aria-label={translate('auto.components.LinearItemDrawer.d369841269', 'Send comment')}
      >
        {submitting ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Send className="size-3.5" />
        )}
      </Button>
    </div>
  )
}

export function initLinearIssueEditState(issue: LinearIssue): LinearEditState {
  return {
    state: issue.state,
    priority: issue.priority,
    estimate: issue.estimate,
    assignee: issue.assignee,
    labelIds: issue.labelIds,
    labels: issue.labels
  }
}

export default function LinearItemDrawer({
  issue,
  onUse,
  onClose
}: LinearItemDrawerProps): React.JSX.Element {
  const [fullIssue, setFullIssue] = useState<LinearIssue | null>(null)
  const [comments, setComments] = useState<LinearComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [editState, setEditState] = useState<LinearEditState | null>(null)
  const requestIdRef = useRef(0)
  const hasEditedRef = useRef(false)
  const optimisticCommentsRef = useRef<LinearComment[]>([])
  const settings = useAppStore((s) => s.settings)

  const handleEditStateChange = useCallback((patch: Partial<LinearEditState>) => {
    hasEditedRef.current = true
    setFullIssue((prev) => (prev ? { ...prev, ...patch } : prev))
    setEditState((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const handleIssueTextChange = useCallback(
    (patch: Partial<Pick<LinearIssue, 'title' | 'description'>>) => {
      hasEditedRef.current = true
      setFullIssue((prev) => (prev ? { ...prev, ...patch } : prev))
    },
    []
  )

  // Why: the list view may not include the full description. Re-fetch
  // the issue by ID and its comments to populate the drawer.
  useEffect(() => {
    if (!issue) {
      setFullIssue(null)
      setComments([])
      setEditState(null)
      hasEditedRef.current = false
      return
    }
    hasEditedRef.current = false
    optimisticCommentsRef.current = []
    setComments([])
    setCommentsLoading(true)
    setEditState(initLinearIssueEditState(issue))
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    setFullIssue(issue)

    // Why: fetch issue and comments independently so a transient comments
    // failure doesn't discard the successfully-fetched issue data.
    linearGetIssue(settings, issue.id, issue.workspaceId)
      .then((issueResult) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (issueResult) {
          const fetched = issueResult as LinearIssue
          setFullIssue(fetched)
          // Why: skip if the user already made optimistic edits — the fetch
          // carries pre-edit data that would clobber in-flight changes.
          if (!hasEditedRef.current) {
            setEditState(initLinearIssueEditState(fetched))
          }
        }
      })
      .catch(() => {})

    linearIssueComments(settings, issue.id, issue.workspaceId)
      .then((commentsResult) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        // Why: merge any comments the user posted optimistically while the
        // fetch was in-flight, using id to avoid duplicates.
        let fetched = commentsResult as LinearComment[]
        const opt = optimisticCommentsRef.current
        if (opt.length > 0) {
          const fetchedIds = new Set(fetched.map((c) => c.id))
          const missing = opt.filter((c) => !fetchedIds.has(c.id))
          if (missing.length > 0) {
            fetched = [...fetched, ...missing]
          }
        }
        setComments(fetched)
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setCommentsLoading(false)
        }
      })
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, issue?.workspaceId, settings])

  // Why: same pointer-events fix as GitHubItemDialog — Radix may leave
  // pointer-events: none on body when overlays transition.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!issue?.id) {
      return
    }
    let cancelled = false
    let count = 0
    let frameId: number | null = null
    const tick = (): void => {
      frameId = null
      if (cancelled) {
        return
      }
      if (document.body.style.pointerEvents === 'none') {
        document.body.style.pointerEvents = ''
      }
      if (count++ < 5) {
        frameId = requestAnimationFrame(tick)
      }
    }
    tick()
    return () => {
      cancelled = true
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
    }
  }, [issue?.id])

  const handleCommentAdded = useCallback((comment: LinearLocalComment) => {
    const newComment: LinearComment = {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      user: { displayName: 'You' }
    }
    optimisticCommentsRef.current.push(newComment)
    setComments((prev) => [...prev, newComment])
  }, [])

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
          <SheetTitle>
            {displayed?.title ??
              translate('auto.components.LinearItemDrawer.39883467f4', 'Linear issue')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.LinearItemDrawer.04a442f796',
              'Preview and edit the selected Linear issue.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {displayed && (
          <div className="flex h-full min-h-0 flex-col">
            {/* Header */}
            <div className="flex-none border-b border-border/60 px-4 py-3">
              <div className="flex items-start gap-2">
                <LinearIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-[12px] text-muted-foreground">
                    {displayed.identifier}
                  </span>
                  <div className="mt-1">
                    <LinearIssueTextEditor
                      issue={displayed}
                      onIssueChange={handleIssueTextChange}
                      density="drawer"
                      fields="title"
                    />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    {displayed.workspaceName && <span>{displayed.workspaceName}</span>}
                    {displayed.team?.name && <span>{displayed.team.name}</span>}
                    <span>· {formatRelativeTime(displayed.updatedAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => window.api.shell.openUrl(displayed.url)}
                        aria-label={translate(
                          'auto.components.LinearItemDrawer.0190b760c1',
                          'Open on Linear'
                        )}
                      >
                        <ExternalLink className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      {translate('auto.components.LinearItemDrawer.0190b760c1', 'Open on Linear')}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={onClose}
                        aria-label={translate(
                          'auto.components.LinearItemDrawer.858d0630da',
                          'Close preview'
                        )}
                      >
                        <X className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      {translate('auto.components.LinearItemDrawer.9dc54172db', 'Close · Esc')}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>

            {/* Edit section */}
            {editState && (
              <LinearIssueEditSection
                issue={displayed}
                editState={editState}
                onEditStateChange={handleEditStateChange}
              />
            )}

            {/* Body + comments */}
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
              <div className="px-4 py-4">
                <LinearIssueTextEditor
                  issue={displayed}
                  onIssueChange={handleIssueTextChange}
                  density="drawer"
                  fields="description"
                />
              </div>

              <div className="border-t border-border/40 px-4 py-4">
                <div className="flex items-center gap-2 pb-3">
                  <span className="text-[13px] font-medium text-foreground">
                    {translate('auto.components.LinearItemDrawer.fde849b2b6', 'Comments')}
                  </span>
                  {comments.length > 0 && (
                    <span className="text-[12px] text-muted-foreground">{comments.length}</span>
                  )}
                </div>
                {commentsLoading && comments.length === 0 ? (
                  <div className="flex items-center justify-center py-6">
                    <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                  </div>
                ) : comments.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    {translate('auto.components.LinearItemDrawer.a4fcc57522', 'No comments yet.')}
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {comments.map((comment) => (
                      <div
                        key={comment.id}
                        className="rounded-lg border border-border/40 bg-background/30"
                      >
                        <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
                          {comment.user?.avatarUrl && (
                            <img
                              src={comment.user.avatarUrl}
                              alt={comment.user.displayName}
                              className="size-5 shrink-0 rounded-full"
                            />
                          )}
                          <span className="text-[13px] font-semibold text-foreground">
                            {comment.user?.displayName ??
                              translate('auto.components.LinearItemDrawer.48e17e8cbd', 'Unknown')}
                          </span>
                          <span className="text-[12px] text-muted-foreground">
                            · {formatRelativeTime(comment.createdAt)}
                          </span>
                        </div>
                        <div className="px-3 py-2">
                          <CommentMarkdown
                            content={comment.body}
                            className="text-[13px] leading-relaxed"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Comment footer + Start workspace */}
            <LinearIssueCommentFooter
              issueId={displayed.id}
              workspaceId={displayed.workspaceId}
              onCommentAdded={handleCommentAdded}
            />
            <div className="flex-none border-t border-border/60 bg-background/40 px-4 py-3">
              <Button
                onClick={() => onUse(displayed)}
                className="w-full justify-center gap-2"
                aria-label={translate(
                  'auto.components.LinearItemDrawer.04008e6c46',
                  'Start workspace from issue'
                )}
              >
                {translate(
                  'auto.components.LinearItemDrawer.04008e6c46',
                  'Start workspace from issue'
                )}
                <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
