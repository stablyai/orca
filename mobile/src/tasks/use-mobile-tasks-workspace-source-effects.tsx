import { legacyBaseRefSearchResult } from '../../../src/shared/base-ref-search-result'
import type { WorkspaceCreateProjectionModel } from './use-mobile-tasks-workspace-create-projection'
import { type SparsePreset, useEffect } from './mobile-tasks-dependencies'
import { repoSparsePresetListRead } from './mobile-workspace-source-operations'
import { repoBaseRefSearchRead } from '../source-control/mobile-repo-base-ref-operations'

export type WorkspaceSourceEffectsInput = Pick<
  WorkspaceCreateProjectionModel,
  | 'client'
  | 'setWorkspaceBaseBranchError'
  | 'setWorkspaceBaseBranchLoading'
  | 'setWorkspaceBaseBranchResults'
  | 'setWorkspaceSparseDraft'
  | 'setWorkspaceSparsePresetId'
  | 'setWorkspaceSparsePresets'
  | 'setWorkspaceSparsePresetsError'
  | 'setWorkspaceSparsePresetsLoaded'
  | 'setWorkspaceSparsePresetsLoading'
  | 'showWorkspaceBaseBranchPicker'
  | 'tasksSupported'
  | 'workspaceBaseBranchQuery'
  | 'workspaceCreateDraft'
  | 'workspaceCreateTargetRepo'
  | 'workspaceSparseReloadKey'
>

export function useMobileTasksWorkspaceSourceEffects<Model extends WorkspaceSourceEffectsInput>(
  model: Model
): Model {
  const {
    client,
    setWorkspaceBaseBranchError,
    setWorkspaceBaseBranchLoading,
    setWorkspaceBaseBranchResults,
    setWorkspaceSparseDraft,
    setWorkspaceSparsePresetId,
    setWorkspaceSparsePresets,
    setWorkspaceSparsePresetsError,
    setWorkspaceSparsePresetsLoaded,
    setWorkspaceSparsePresetsLoading,
    showWorkspaceBaseBranchPicker,
    tasksSupported,
    workspaceBaseBranchQuery,
    workspaceCreateDraft,
    workspaceCreateTargetRepo,
    workspaceSparseReloadKey
  } = model
  useEffect(() => {
    // A reconnect keeps the form's preset choice; the reload once connected drops it only if the preset is gone.
    if (!tasksSupported || !client) {
      setWorkspaceSparsePresetsLoading(false)
      return
    }
    if (
      !workspaceCreateDraft ||
      !workspaceCreateTargetRepo ||
      workspaceCreateTargetRepo.connectionId
    ) {
      setWorkspaceSparsePresets([])
      setWorkspaceSparsePresetsLoading(false)
      setWorkspaceSparsePresetsLoaded(false)
      setWorkspaceSparsePresetsError('')
      setWorkspaceSparsePresetId(null)
      setWorkspaceSparseDraft(null)
      return
    }

    let stale = false
    setWorkspaceSparsePresetsLoading(true)
    setWorkspaceSparsePresetsLoaded(false)
    setWorkspaceSparsePresetsError('')
    void repoSparsePresetListRead
      .request(client, { repo: `id:${workspaceCreateTargetRepo.id}` })
      .then((reply) => {
        if (stale) {
          return
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the schema requires every member read without a guard (`id`, `name`, `directories`) and drops a row missing one. The cast covers the other three SparsePreset declares non-optional (`repoId`, `createdAt`, `updatedAt`), which the recorded preset does not carry and nothing here reads.
        const presets = repoSparsePresetListRead.interpret(reply) as SparsePreset[]
        setWorkspaceSparsePresets(presets)
        setWorkspaceSparsePresetsLoaded(true)
        setWorkspaceSparsePresetId((current) =>
          current && presets.some((preset) => preset.id === current) ? current : null
        )
      })
      .catch((err) => {
        if (!stale) {
          setWorkspaceSparsePresets([])
          setWorkspaceSparsePresetsLoaded(false)
          setWorkspaceSparsePresetId(null)
          setWorkspaceSparsePresetsError(
            err instanceof Error ? err.message : 'Failed to load sparse presets.'
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setWorkspaceSparsePresetsLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [
    client,
    tasksSupported,
    workspaceCreateDraft,
    workspaceCreateTargetRepo,
    workspaceSparseReloadKey
  ])

  useEffect(() => {
    if (
      !client ||
      !tasksSupported ||
      !workspaceCreateDraft ||
      !workspaceCreateTargetRepo ||
      !showWorkspaceBaseBranchPicker
    ) {
      setWorkspaceBaseBranchResults([])
      setWorkspaceBaseBranchLoading(false)
      setWorkspaceBaseBranchError('')
      return
    }
    const query = workspaceBaseBranchQuery.trim()
    if (!query) {
      setWorkspaceBaseBranchResults([])
      setWorkspaceBaseBranchLoading(false)
      setWorkspaceBaseBranchError('')
      return
    }

    let stale = false
    setWorkspaceBaseBranchLoading(true)
    setWorkspaceBaseBranchError('')
    void repoBaseRefSearchRead
      .request(
        client,
        { repo: `id:${workspaceCreateTargetRepo.id}`, query, limit: 20 },
        { timeoutMs: 30_000 }
      )
      .then((reply) => {
        if (stale) {
          return
        }
        const result = repoBaseRefSearchRead.interpret(reply)
        setWorkspaceBaseBranchResults(
          result.refDetails ?? (result.refs ?? []).map(legacyBaseRefSearchResult)
        )
      })
      .catch((err) => {
        if (!stale) {
          setWorkspaceBaseBranchResults([])
          setWorkspaceBaseBranchError(
            err instanceof Error ? err.message : 'Failed to search branches.'
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setWorkspaceBaseBranchLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [
    client,
    tasksSupported,
    showWorkspaceBaseBranchPicker,
    workspaceBaseBranchQuery,
    workspaceCreateDraft,
    workspaceCreateTargetRepo
  ])
  return model
}

export type WorkspaceSourceEffectsModel = WorkspaceCreateProjectionModel
