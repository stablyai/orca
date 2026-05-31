import type React from 'react'
import { LoaderCircle, Pencil, RotateCcw, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { LinearIssueLabel, LinearTeam } from '../../../shared/types'
import type { LabelsWorkspaceViewState } from './linear-label-form-model'
import { isLinearLabelRetired } from './linear-label-form-model'

type LinearLabelListProps = {
  viewState: LabelsWorkspaceViewState
  labels: LinearIssueLabel[]
  error: string | null
  selectedTeam: LinearTeam | null | undefined
  workspaceMutationsEnabled: boolean
  mutatingLabelId: string | null
  onEdit: (label: LinearIssueLabel) => void
  onRetire: (label: LinearIssueLabel) => void
  onRestore: (label: LinearIssueLabel) => void
}

export function LinearLabelList({
  viewState,
  labels,
  error,
  selectedTeam,
  workspaceMutationsEnabled,
  mutatingLabelId,
  onEdit,
  onRetire,
  onRestore
}: LinearLabelListProps): React.JSX.Element {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
      style={{ scrollbarGutter: 'stable' }}
    >
      {viewState === 'loading' ? (
        <div className="divide-y divide-border/50">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="px-4 py-3">
              <div className="h-4 w-2/5 animate-pulse rounded bg-muted/70" />
              <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
            </div>
          ))}
        </div>
      ) : null}

      {viewState === 'error' ? (
        <div className="border-b border-border px-4 py-4 text-sm text-destructive">{error}</div>
      ) : null}

      {viewState === 'empty' ? (
        <div className="px-4 py-10 text-center">
          <p className="text-sm font-medium text-foreground">No Linear labels found</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {selectedTeam
              ? `No labels for ${selectedTeam.name}.`
              : 'Create a label to start organizing issues.'}
          </p>
        </div>
      ) : null}

      {viewState === 'ready' ? (
        <div className="divide-y divide-border/50">
          {labels.map((label) => {
            const archived = isLinearLabelRetired(label)
            return (
              <div key={label.id} className="flex items-center gap-3 px-4 py-3">
                <span
                  aria-hidden
                  className="size-3 shrink-0 rounded-full border border-border/40"
                  style={{ backgroundColor: label.color }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {label.name}
                    </span>
                    {label.isGroup ? (
                      <span className="rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        Group
                      </span>
                    ) : null}
                    {archived ? (
                      <span className="rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        Retired
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{label.teamName ? `${label.teamName} team` : 'Workspace label'}</span>
                    {label.parentName ? <span>Group: {label.parentName}</span> : null}
                    {label.description ? (
                      <span className="truncate">{label.description}</span>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => onEdit(label)}
                    disabled={!workspaceMutationsEnabled || archived}
                    aria-label={`Edit ${label.name}`}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  {archived ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => onRestore(label)}
                      disabled={!workspaceMutationsEnabled || mutatingLabelId === label.id}
                      aria-label={`Restore ${label.name}`}
                    >
                      {mutatingLabelId === label.id ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => onRetire(label)}
                      disabled={!workspaceMutationsEnabled || mutatingLabelId === label.id}
                      aria-label={`Retire ${label.name}`}
                    >
                      {mutatingLabelId === label.id ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
