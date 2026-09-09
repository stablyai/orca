import React from 'react'
import { Clock, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { translate } from '@/i18n/i18n'
import { getExecutionHostLabel, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Automation } from '../../../../shared/automations-types'
import type { Repo } from '../../../../shared/types'
import type { AutomationTargetAvailability } from './automation-target-availability'

export type AutomationListRowProps = {
  automation: Automation
  isSelected: boolean
  automationRepo: Repo | undefined
  workspaceLabel: string
  agentLabel: string
  scheduleLabel: string
  usageText: string
  nextRunLabel: string
  runAvailability: AutomationTargetAvailability
  // CR-AUTO-001/FE-TASK-AUTO-001: same map AutomationDetail.tsx uses, so a row and
  // the detail panel always agree on a runtime environment's display name.
  hostLabelById?: ReadonlyMap<string, string>
  onSelect: () => void
  onRunNow: () => void
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}

// Extracted from AutomationsPage.tsx (FE-TASK-AUTO-001) so the row markup can be
// render-tested and gain the "runs on" badge without growing that file further.
export function AutomationListRow({
  automation,
  isSelected,
  automationRepo,
  workspaceLabel,
  agentLabel,
  scheduleLabel,
  usageText,
  nextRunLabel,
  runAvailability,
  hostLabelById,
  onSelect,
  onRunNow,
  onEdit,
  onToggle,
  onDelete
}: AutomationListRowProps): React.JSX.Element {
  const runHostId = automation.runContext?.hostId ?? LOCAL_EXECUTION_HOST_ID
  const runHostLabel = hostLabelById?.get(runHostId) ?? getExecutionHostLabel(runHostId)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            'mb-1 grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors',
            isSelected
              ? 'border-foreground/30 bg-muted/70 text-foreground shadow-sm'
              : 'border-transparent hover:bg-muted/50'
          )}
        >
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'size-2 rounded-full',
                  automation.enabled ? 'bg-foreground' : 'bg-muted-foreground/40'
                )}
              />
              <span className="truncate font-medium">{automation.name}</span>
            </span>
            <span className="mt-1 block truncate text-xs font-medium text-foreground/80">
              {scheduleLabel}
            </span>
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {automationRepo ? (
                <RepoBadgeLabel
                  name={automationRepo.displayName}
                  color={automationRepo.badgeColor}
                  badgeClassName="size-1.5"
                />
              ) : (
                <span>
                  {translate(
                    'auto.components.automations.AutomationsPage.13118faadf',
                    'Unknown project'
                  )}
                </span>
              )}
              <span className="shrink-0">/</span>
              <span className="truncate">{workspaceLabel}</span>
              <span className="shrink-0">·</span>
              <span className="truncate">{agentLabel}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline">{runHostLabel}</Badge>
                </TooltipTrigger>
                <TooltipContent>
                  {translate(
                    'auto.components.automations.AutomationListRow.runHostTooltip',
                    'Runs on {{host}}',
                    { host: runHostLabel }
                  )}
                </TooltipContent>
              </Tooltip>
            </span>
            <span className="mt-1 block truncate text-xs text-muted-foreground">{usageText}</span>
          </span>
          <span className="flex max-w-28 flex-col items-end gap-1 text-right text-xs text-muted-foreground">
            <Clock className="size-3.5" />
            <span className="line-clamp-2">{nextRunLabel}</span>
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem
          disabled={!runAvailability.canRunNow}
          onSelect={(event) => {
            if (!runAvailability.canRunNow) {
              event.preventDefault()
              return
            }
            onRunNow()
          }}
        >
          <Play className="size-3.5" />
          <span className="min-w-0 truncate">
            {runAvailability.canRunNow
              ? translate('auto.components.automations.AutomationsPage.2faecab10b', 'Run Now')
              : runAvailability.message}
          </span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onEdit}>
          <Pencil className="size-3.5" />
          {translate('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onToggle}>
          {automation.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {automation.enabled
            ? translate('auto.components.automations.AutomationsPage.b457436d6a', 'Pause')
            : translate('auto.components.automations.AutomationsPage.376631ef2b', 'Resume')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-3.5" />
          {translate('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
