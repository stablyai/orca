import type { WorkspaceCreateProjectionModel } from './use-mobile-tasks-workspace-create-projection'
import { type SparsePreset, useEffect } from './mobile-tasks-dependencies'
import {
  repoBaseRefSearchRead,
  repoSparsePresetListRead
} from './mobile-workspace-source-operations'

export function useMobileTasksWorkspaceSourceEffects(model: WorkspaceCreateProjectionModel) {
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
    if (!tasksSupported || !client || !workspaceCreateDraft || !workspaceCreateTargetRepo) {
      setWorkspaceSparsePresets([])
      setWorkspaceSparsePresetsLoading(false)
      setWorkspaceSparsePresetsLoaded(false)
      setWorkspaceSparsePresetsError('')
      setWorkspaceSparsePresetId(null)
      setWorkspaceSparseDraft(null)
      return
    }
    if (workspaceCreateTargetRepo.connectionId) {
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
          result.refDetails ??
            (result.refs ?? []).map((refName) => ({ refName, localBranchName: refName }))
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

export type WorkspaceSourceEffectsModel = ReturnType<typeof useMobileTasksWorkspaceSourceEffects>
