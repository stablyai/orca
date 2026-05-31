import React, { useMemo, useState } from 'react'
import { ExternalLink, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { cn } from '@/lib/utils'
import { clearLinearMetadataCache } from '@/hooks/useIssueMetadata'
import {
  linearCreateIssueLabel,
  linearRestoreIssueLabel,
  linearRetireIssueLabel,
  linearUpdateIssueLabel,
  type RuntimeLinearSettings
} from '@/runtime/runtime-linear-client'
import type { LinearIssueLabel, LinearTeam, LinearWorkspaceSelection } from '../../../shared/types'
import { LinearLabelFormDialog } from './LinearLabelFormDialog'
import { LinearLabelList } from './LinearLabelList'
import {
  compactLinearLabelCreateInput,
  compactLinearLabelUpdateInput,
  emptyLinearLabelForm,
  getLinearLabelParentOptions,
  linearLabelFormFromLabel,
  selectedWorkspaceCanMutate,
  type LabelFormState
} from './linear-label-form-model'
import { useLinearLabelCatalog } from './use-linear-label-catalog'

export {
  compactLinearLabelCreateInput,
  compactLinearLabelUpdateInput,
  getLinearLabelParentOptions,
  getLinearLabelsWorkspaceViewState,
  isLinearLabelRetired,
  reconcileSelectedLinearLabelTeamId,
  type LabelFormState
} from './linear-label-form-model'

type LinearLabelsWorkspaceProps = {
  settings: RuntimeLinearSettings
  workspaceId: LinearWorkspaceSelection | null
  teams: LinearTeam[]
}

export type LinearLabelMutationDeps = {
  createIssueLabel: typeof linearCreateIssueLabel
  updateIssueLabel: typeof linearUpdateIssueLabel
  retireIssueLabel: typeof linearRetireIssueLabel
  restoreIssueLabel: typeof linearRestoreIssueLabel
  clearMetadataCache: typeof clearLinearMetadataCache
}

const defaultMutationDeps: LinearLabelMutationDeps = {
  createIssueLabel: linearCreateIssueLabel,
  updateIssueLabel: linearUpdateIssueLabel,
  retireIssueLabel: linearRetireIssueLabel,
  restoreIssueLabel: linearRestoreIssueLabel,
  clearMetadataCache: clearLinearMetadataCache
}

export async function saveLinearLabelForm(
  form: LabelFormState,
  settings: RuntimeLinearSettings,
  workspaceId: LinearWorkspaceSelection | null,
  deps: LinearLabelMutationDeps = defaultMutationDeps
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (!selectedWorkspaceCanMutate(workspaceId)) {
    return { ok: false, error: 'Select one Linear workspace before editing labels.' }
  }
  if (!form.name.trim()) {
    return { ok: false, error: 'Label name is required.' }
  }
  if (form.id) {
    const result = await deps.updateIssueLabel(
      settings,
      form.id,
      compactLinearLabelUpdateInput(form),
      workspaceId
    )
    if (!result.ok) {
      return result
    }
    deps.clearMetadataCache()
    return { ok: true, message: result.warning ?? 'Linear label updated.' }
  }

  const result = await deps.createIssueLabel(
    settings,
    compactLinearLabelCreateInput(form),
    workspaceId
  )
  if (!result.ok) {
    return result
  }
  deps.clearMetadataCache()
  return { ok: true, message: result.warning ?? 'Linear label created.' }
}

export async function mutateLinearLabelArchiveState(
  label: LinearIssueLabel,
  settings: RuntimeLinearSettings,
  workspaceId: LinearWorkspaceSelection | null,
  action: 'retire' | 'restore',
  deps: LinearLabelMutationDeps = defaultMutationDeps
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (!selectedWorkspaceCanMutate(workspaceId)) {
    return { ok: false, error: 'Select one Linear workspace before editing labels.' }
  }
  if (action === 'retire') {
    const result = await deps.retireIssueLabel(settings, label.id, workspaceId)
    if (!result.ok) {
      return result
    }
    deps.clearMetadataCache()
    return { ok: true, message: result.warning ?? 'Linear label retired.' }
  }

  const result = await deps.restoreIssueLabel(settings, label.id, workspaceId)
  if (!result.ok) {
    return result
  }
  deps.clearMetadataCache()
  return { ok: true, message: result.warning ?? 'Linear label restored.' }
}

export default function LinearLabelsWorkspace({
  settings,
  workspaceId,
  teams
}: LinearLabelsWorkspaceProps): React.JSX.Element {
  const confirm = useConfirmationDialog()
  const catalog = useLinearLabelCatalog({ settings, workspaceId, teams })
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<LabelFormState>(() => emptyLinearLabelForm())
  const [submitting, setSubmitting] = useState(false)
  const [mutatingLabelId, setMutatingLabelId] = useState<string | null>(null)

  const workspaceMutationsEnabled = selectedWorkspaceCanMutate(workspaceId)
  const selectedTeamUrl = catalog.selectedTeamUrl
  const parentOptions = useMemo(
    () => getLinearLabelParentOptions(catalog.labels, form.id),
    [catalog.labels, form.id]
  )

  const openCreateForm = () => {
    setForm(
      emptyLinearLabelForm(
        catalog.effectiveSelectedTeamId === 'all' ? 'workspace' : catalog.effectiveSelectedTeamId
      )
    )
    setFormOpen(true)
  }

  const openEditForm = (label: LinearIssueLabel) => {
    setForm(linearLabelFormFromLabel(label))
    setFormOpen(true)
  }

  const handleSubmit = async (): Promise<void> => {
    setSubmitting(true)
    try {
      const result = await saveLinearLabelForm(form, settings, workspaceId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setFormOpen(false)
      catalog.refresh()
      toast.success(result.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save Linear label')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRetire = async (label: LinearIssueLabel): Promise<void> => {
    const ok = await confirm({
      title: 'Retire Linear label?',
      description: `Retire “${label.name}” so it cannot be applied to new issues?`,
      confirmLabel: 'Retire',
      cancelLabel: 'Cancel',
      confirmVariant: 'destructive'
    })
    if (!ok) {
      return
    }
    setMutatingLabelId(label.id)
    try {
      const result = await mutateLinearLabelArchiveState(label, settings, workspaceId, 'retire')
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      catalog.refresh()
      toast.success(result.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to retire Linear label')
    } finally {
      setMutatingLabelId(null)
    }
  }

  const handleRestore = async (label: LinearIssueLabel): Promise<void> => {
    setMutatingLabelId(label.id)
    try {
      const result = await mutateLinearLabelArchiveState(label, settings, workspaceId, 'restore')
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      catalog.refresh()
      toast.success(result.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to restore Linear label')
    } finally {
      setMutatingLabelId(null)
    }
  }

  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <div className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3 py-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Linear labels
          </div>
          {!workspaceMutationsEnabled ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Select one workspace before creating or editing labels.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={catalog.effectiveSelectedTeamId} onValueChange={catalog.setSelectedTeamId}>
            <SelectTrigger className="h-8 w-[190px] border-border/50 bg-background/70 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All labels</SelectItem>
              {teams.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.workspaceName && workspaceId === 'all' ? `${team.workspaceName} · ` : ''}
                  {team.key} — {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedTeamUrl ? (
            <Button
              variant="outline"
              size="icon"
              onClick={() => window.api.shell.openUrl(selectedTeamUrl)}
              aria-label={`View ${catalog.selectedTeam?.name ?? 'team'} on Linear`}
              title={`View ${catalog.selectedTeam?.name ?? 'team'} on Linear`}
              className="size-8 border-border/50 bg-background/70"
            >
              <ExternalLink className="size-3.5" />
            </Button>
          ) : null}
          <Toggle
            pressed={catalog.includeArchived}
            onPressedChange={catalog.setIncludeArchived}
            size="sm"
            className="h-8 gap-2 bg-transparent px-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground data-[state=on]:bg-transparent data-[state=on]:text-foreground"
            aria-label="Show retired labels"
          >
            <span>Show retired</span>
            <span
              aria-hidden
              className={cn(
                'relative inline-flex h-4 w-7 rounded-full border transition-colors',
                catalog.includeArchived
                  ? 'border-primary bg-primary'
                  : 'border-border/60 bg-muted/60'
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 left-0.5 size-2.5 rounded-full bg-background shadow-xs transition-transform',
                  catalog.includeArchived && 'translate-x-3'
                )}
              />
            </span>
          </Toggle>
          <Button
            variant="outline"
            size="icon"
            onClick={catalog.refresh}
            disabled={catalog.loading}
            aria-label="Refresh Linear labels"
            className="size-8 border-border/50 bg-background/70"
          >
            {catalog.loading ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
          <Button
            size="sm"
            onClick={openCreateForm}
            disabled={!workspaceMutationsEnabled}
            className="h-8 gap-1 text-xs"
          >
            <Plus className="size-3.5" />
            New label
          </Button>
        </div>
      </div>

      <LinearLabelList
        viewState={catalog.viewState}
        labels={catalog.labels}
        error={catalog.error}
        selectedTeam={catalog.selectedTeam}
        workspaceMutationsEnabled={workspaceMutationsEnabled}
        mutatingLabelId={mutatingLabelId}
        onEdit={openEditForm}
        onRetire={(label) => void handleRetire(label)}
        onRestore={(label) => void handleRestore(label)}
      />

      <LinearLabelFormDialog
        open={formOpen}
        form={form}
        teams={teams}
        parentOptions={parentOptions}
        submitting={submitting}
        onOpenChange={setFormOpen}
        onFormChange={setForm}
        onSubmit={() => void handleSubmit()}
      />
    </div>
  )
}
