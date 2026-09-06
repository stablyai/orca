import type { WorkspaceSourceEffectsModel } from './use-mobile-tasks-workspace-source-effects'
import { type SparsePreset, useCallback, useEffect } from './mobile-tasks-dependencies'
import { sortSparsePresetsByName } from './mobile-tasks-model'

export function useMobileTasksWorkspaceSparseActions(model: WorkspaceSourceEffectsModel) {
  const {
    canSaveWorkspaceSparseDraft,
    setShowWorkspaceSparsePicker,
    setWorkspaceSparseDraft,
    setWorkspaceSparsePresetId,
    setWorkspaceSparsePresets,
    setWorkspaceSparsePresetsError,
    setWorkspaceSparsePresetsLoaded,
    setWorkspaceSparseSaving,
    setWorkspaceSshConnecting,
    setWorkspaceSshState,
    taskWorkspaceCreationOperations,
    tasksSupported,
    workspaceCreateDraft,
    workspaceCreateTargetConnectionId,
    workspaceCreateTargetRepo,
    workspaceSparseCheckoutAvailable,
    workspaceSparseDraft,
    workspaceSparseDraftName,
    workspaceSparseDraftParsed,
    workspaceSparsePresetId,
    workspaceSparsePresetsLoaded,
    workspaceSparsePresetsLoading
  } = model
  const startNewWorkspaceSparsePreset = useCallback(() => {
    if (
      !workspaceSparseCheckoutAvailable ||
      !workspaceSparsePresetsLoaded ||
      workspaceSparsePresetsLoading
    ) {
      return
    }
    setWorkspaceSparseDraft({ mode: 'new', name: '', directoriesText: '' })
    setShowWorkspaceSparsePicker(false)
  }, [
    workspaceSparseCheckoutAvailable,
    workspaceSparsePresetsLoaded,
    workspaceSparsePresetsLoading
  ])
  const startEditWorkspaceSparsePreset = useCallback(
    (preset: SparsePreset) => {
      if (
        !workspaceSparseCheckoutAvailable ||
        !workspaceSparsePresetsLoaded ||
        workspaceSparsePresetsLoading
      ) {
        return
      }
      setWorkspaceSparseDraft({
        mode: 'edit',
        presetId: preset.id,
        name: preset.name,
        directoriesText: preset.directories.join('\n')
      })
      setShowWorkspaceSparsePicker(false)
    },
    [workspaceSparseCheckoutAvailable, workspaceSparsePresetsLoaded, workspaceSparsePresetsLoading]
  )
  const saveWorkspaceSparsePreset = useCallback(async (): Promise<void> => {
    if (
      !taskWorkspaceCreationOperations ||
      !tasksSupported ||
      !workspaceCreateTargetRepo ||
      !workspaceSparseDraft ||
      !workspaceSparseDraftParsed ||
      !canSaveWorkspaceSparseDraft
    ) {
      return
    }
    setWorkspaceSparseSaving(true)
    setWorkspaceSparsePresetsError('')
    try {
      const saved = await taskWorkspaceCreationOperations.saveSparsePreset(
        workspaceCreateTargetRepo.id,
        {
          ...(workspaceSparseDraft.presetId ? { id: workspaceSparseDraft.presetId } : {}),
          name: workspaceSparseDraftName,
          directories: workspaceSparseDraftParsed.directories
        }
      )
      setWorkspaceSparsePresets((current) => {
        const withoutSaved = current.filter((preset) => preset.id !== saved.id)
        return sortSparsePresetsByName([...withoutSaved, saved])
      })
      setWorkspaceSparsePresetsLoaded(true)
      if (workspaceSparseDraft.mode === 'new' || workspaceSparsePresetId === saved.id) {
        setWorkspaceSparsePresetId(saved.id)
      }
      setWorkspaceSparseDraft(null)
    } catch (err) {
      setWorkspaceSparsePresetsError(
        err instanceof Error ? err.message : 'Failed to save sparse preset.'
      )
    } finally {
      setWorkspaceSparseSaving(false)
    }
  }, [
    canSaveWorkspaceSparseDraft,
    taskWorkspaceCreationOperations,
    tasksSupported,
    workspaceCreateTargetRepo,
    workspaceSparseDraft,
    workspaceSparseDraftName,
    workspaceSparseDraftParsed,
    workspaceSparsePresetId
  ])
  useEffect(() => {
    if (
      !tasksSupported ||
      !taskWorkspaceCreationOperations ||
      !workspaceCreateDraft ||
      !workspaceCreateTargetConnectionId
    ) {
      setWorkspaceSshState(null)
      setWorkspaceSshConnecting(false)
      return
    }

    let stale = false
    void taskWorkspaceCreationOperations
      .readSshState(workspaceCreateTargetConnectionId)
      .then((state) => {
        if (stale) {
          return
        }
        setWorkspaceSshState(state)
      })
      .catch((err) => {
        if (!stale) {
          setWorkspaceSshState({
            targetId: workspaceCreateTargetConnectionId,
            status: 'error',
            error: err instanceof Error ? err.message : 'Failed to read SSH connection state.',
            reconnectAttempt: 0
          })
        }
      })

    return () => {
      stale = true
    }
  }, [
    taskWorkspaceCreationOperations,
    tasksSupported,
    workspaceCreateDraft,
    workspaceCreateTargetConnectionId
  ])
  return Object.assign(model, {
    saveWorkspaceSparsePreset,
    startEditWorkspaceSparsePreset,
    startNewWorkspaceSparsePreset
  })
}

export type WorkspaceSparseActionsModel = ReturnType<typeof useMobileTasksWorkspaceSparseActions>
