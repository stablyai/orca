/* eslint-disable max-lines -- Why: the label catalog view keeps list, form,
   and retire/restore actions together until more Linear admin surfaces exist. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ExternalLink,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { clearLinearMetadataCache } from '@/hooks/useIssueMetadata'
import {
  linearCreateIssueLabel,
  linearListIssueLabels,
  linearRestoreIssueLabel,
  linearRetireIssueLabel,
  linearUpdateIssueLabel,
  type LinearIssueLabelListOptions,
  type RuntimeLinearSettings
} from '@/runtime/runtime-linear-client'
import type {
  LinearIssueLabel,
  LinearIssueLabelCreateInput,
  LinearIssueLabelUpdateInput,
  LinearTeam,
  LinearWorkspaceSelection
} from '../../../shared/types'

export type LabelFormState = {
  id?: string
  name: string
  color: string
  description: string
  teamId: string
  parentId: string
  isGroup: boolean
}

type LabelsWorkspaceViewState = 'loading' | 'error' | 'empty' | 'ready'

export function getLinearLabelsWorkspaceViewState(args: {
  loading: boolean
  error: string | null
  labels: LinearIssueLabel[]
}): LabelsWorkspaceViewState {
  if (args.loading && args.labels.length === 0) {
    return 'loading'
  }
  if (args.error) {
    return 'error'
  }
  if (args.labels.length === 0) {
    return 'empty'
  }
  return 'ready'
}

export function reconcileSelectedLinearLabelTeamId(
  selectedTeamId: string,
  teams: LinearTeam[]
): string {
  if (selectedTeamId === 'all') {
    return selectedTeamId
  }
  return teams.some((team) => team.id === selectedTeamId) ? selectedTeamId : 'all'
}

function emptyForm(teamId = 'workspace'): LabelFormState {
  return {
    name: '',
    color: '#5E6AD2',
    description: '',
    teamId,
    parentId: 'none',
    isGroup: false
  }
}

function formFromLabel(label: LinearIssueLabel): LabelFormState {
  return {
    id: label.id,
    name: label.name,
    color: label.color || '#5E6AD2',
    description: label.description ?? '',
    teamId: label.teamId ?? 'workspace',
    parentId: label.parentId ?? 'none',
    isGroup: label.isGroup
  }
}

export function compactLinearLabelCreateInput(form: LabelFormState): LinearIssueLabelCreateInput {
  return {
    name: form.name.trim(),
    color: form.color.trim() || undefined,
    description: form.description.trim() || undefined,
    teamId: form.teamId === 'workspace' ? null : form.teamId,
    parentId: form.parentId === 'none' ? null : form.parentId,
    isGroup: form.isGroup
  }
}

export function compactLinearLabelUpdateInput(form: LabelFormState): LinearIssueLabelUpdateInput {
  return {
    name: form.name.trim(),
    color: form.color.trim() || undefined,
    description: form.description.trim() || null,
    parentId: form.parentId === 'none' ? null : form.parentId,
    isGroup: form.isGroup
  }
}

function selectedWorkspaceCanMutate(
  workspaceId: LinearWorkspaceSelection | null
): workspaceId is string {
  return Boolean(workspaceId && workspaceId !== 'all')
}

export function isLinearLabelRetired(label: LinearIssueLabel): boolean {
  return Boolean(label.archivedAt || label.retiredAt || label.retired)
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
  const result = form.id
    ? await deps.updateIssueLabel(
        settings,
        form.id,
        compactLinearLabelUpdateInput(form),
        workspaceId
      )
    : await deps.createIssueLabel(settings, compactLinearLabelCreateInput(form), workspaceId)
  if (!result.ok) {
    return result
  }
  deps.clearMetadataCache()
  return { ok: true, message: form.id ? 'Linear label updated.' : 'Linear label created.' }
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
  const result =
    action === 'retire'
      ? await deps.retireIssueLabel(settings, label.id, workspaceId)
      : await deps.restoreIssueLabel(settings, label.id, workspaceId)
  if (!result.ok) {
    return result
  }
  deps.clearMetadataCache()
  return {
    ok: true,
    message: action === 'retire' ? 'Linear label retired.' : 'Linear label restored.'
  }
}

export default function LinearLabelsWorkspace({
  settings,
  workspaceId,
  teams
}: {
  settings: RuntimeLinearSettings
  workspaceId: LinearWorkspaceSelection | null
  teams: LinearTeam[]
}): React.JSX.Element {
  const confirm = useConfirmationDialog()
  const [labels, setLabels] = useState<LinearIssueLabel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [selectedTeamId, setSelectedTeamId] = useState('all')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<LabelFormState>(() => emptyForm())
  const [submitting, setSubmitting] = useState(false)
  const [mutatingLabelId, setMutatingLabelId] = useState<string | null>(null)
  const requestSeqRef = useRef(0)

  const workspaceMutationsEnabled = selectedWorkspaceCanMutate(workspaceId)
  const effectiveSelectedTeamId = reconcileSelectedLinearLabelTeamId(selectedTeamId, teams)
  const selectedTeam =
    effectiveSelectedTeamId === 'all'
      ? null
      : teams.find((team) => team.id === effectiveSelectedTeamId)
  const selectedTeamUrl = selectedTeam?.url ?? null

  const loadLabels = useCallback(() => {
    const requestSeq = requestSeqRef.current + 1
    requestSeqRef.current = requestSeq
    setLoading(true)
    setError(null)
    const options: LinearIssueLabelListOptions = {
      workspaceId: workspaceId ?? undefined,
      teamId: effectiveSelectedTeamId === 'all' ? undefined : effectiveSelectedTeamId,
      includeArchived
    }
    void linearListIssueLabels(settings, options)
      .then((next) => {
        if (requestSeqRef.current === requestSeq) {
          setLabels(next)
        }
      })
      .catch((err) => {
        if (requestSeqRef.current === requestSeq) {
          setError(err instanceof Error ? err.message : 'Failed to load Linear labels')
        }
      })
      .finally(() => {
        if (requestSeqRef.current === requestSeq) {
          setLoading(false)
        }
      })
  }, [effectiveSelectedTeamId, includeArchived, settings, workspaceId])

  useEffect(() => {
    loadLabels()
  }, [loadLabels, refreshNonce])

  const parentOptions = useMemo(
    () => labels.filter((label) => label.isGroup && label.id !== form.id && !label.archivedAt),
    [form.id, labels]
  )

  useEffect(() => {
    setSelectedTeamId('all')
  }, [workspaceId])

  useEffect(() => {
    setSelectedTeamId((current) => reconcileSelectedLinearLabelTeamId(current, teams))
  }, [teams])

  const viewState = getLinearLabelsWorkspaceViewState({ loading, error, labels })

  const openCreateForm = () => {
    setForm(emptyForm(effectiveSelectedTeamId === 'all' ? 'workspace' : effectiveSelectedTeamId))
    setFormOpen(true)
  }

  const openEditForm = (label: LinearIssueLabel) => {
    setForm(formFromLabel(label))
    setFormOpen(true)
  }

  const handleSubmit = async (): Promise<void> => {
    if (!workspaceMutationsEnabled) {
      toast.error('Select one Linear workspace before editing labels.')
      return
    }
    if (!form.name.trim()) {
      toast.error('Label name is required.')
      return
    }
    setSubmitting(true)
    try {
      const result = await saveLinearLabelForm(form, settings, workspaceId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setFormOpen(false)
      setRefreshNonce((current) => current + 1)
      toast.success(result.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save Linear label')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRetire = async (label: LinearIssueLabel): Promise<void> => {
    if (!workspaceMutationsEnabled) {
      toast.error('Select one Linear workspace before editing labels.')
      return
    }
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
      setRefreshNonce((current) => current + 1)
      toast.success(result.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to retire Linear label')
    } finally {
      setMutatingLabelId(null)
    }
  }

  const handleRestore = async (label: LinearIssueLabel): Promise<void> => {
    if (!workspaceMutationsEnabled) {
      toast.error('Select one Linear workspace before editing labels.')
      return
    }
    setMutatingLabelId(label.id)
    try {
      const result = await mutateLinearLabelArchiveState(label, settings, workspaceId, 'restore')
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setRefreshNonce((current) => current + 1)
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
          <Select value={effectiveSelectedTeamId} onValueChange={setSelectedTeamId}>
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
              aria-label={`View ${selectedTeam?.name ?? 'team'} on Linear`}
              title={`View ${selectedTeam?.name ?? 'team'} on Linear`}
              className="size-8 border-border/50 bg-background/70"
            >
              <ExternalLink className="size-3.5" />
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIncludeArchived((current) => !current)}
            className="h-8 border-border/50 bg-background/70 text-xs"
          >
            {includeArchived ? 'Hide retired' : 'Show retired'}
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setRefreshNonce((current) => current + 1)}
            disabled={loading}
            aria-label="Refresh Linear labels"
            className="size-8 border-border/50 bg-background/70"
          >
            {loading ? (
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
                      onClick={() => openEditForm(label)}
                      disabled={!workspaceMutationsEnabled || archived}
                      aria-label={`Edit ${label.name}`}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    {archived ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => void handleRestore(label)}
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
                        onClick={() => void handleRetire(label)}
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

      <Dialog open={formOpen} onOpenChange={(open) => !submitting && setFormOpen(open)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit Linear label' : 'New Linear label'}</DialogTitle>
            <DialogDescription>
              Manage the label definition used by Linear issues.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
              Name
              <Input
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
                disabled={submitting}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
              Color
              <Input
                value={form.color}
                onChange={(event) =>
                  setForm((current) => ({ ...current, color: event.target.value }))
                }
                disabled={submitting}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
              Description
              <Input
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
                disabled={submitting}
              />
            </label>
            {!form.id ? (
              <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
                Scope
                <Select
                  value={form.teamId}
                  onValueChange={(value) => setForm((current) => ({ ...current, teamId: value }))}
                  disabled={submitting}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="workspace">Workspace</SelectItem>
                    {teams.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.key} — {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ) : null}
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
              Parent group
              <Select
                value={form.parentId}
                onValueChange={(value) => setForm((current) => ({ ...current, parentId: value }))}
                disabled={submitting}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {parentOptions.map((label) => (
                    <SelectItem key={label.id} value={label.id}>
                      {label.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={form.isGroup}
                onChange={(event) =>
                  setForm((current) => ({ ...current, isGroup: event.target.checked }))
                }
                disabled={submitting}
                className="size-4 rounded border-border bg-background"
              />
              Label group
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={submitting || !form.name.trim()}>
              {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {form.id ? 'Save label' : 'Create label'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
