import type { WorkspaceSourceEffectsModel } from './use-mobile-tasks-workspace-source-effects'
import {
  type SparsePreset,
  type SshConnectionState,
  useCallback,
  useEffect
} from './mobile-tasks-dependencies'
import { isSuccess, sortSparsePresetsByName } from './mobile-tasks-legacy-foundation'

export function useMobileTasksWorkspaceSparseActions(model: WorkspaceSourceEffectsModel) {
  const {
    canSaveWorkspaceSparseDraft,
    client,
    setShowWorkspaceSparsePicker,
    setWorkspaceSparseDraft,
    setWorkspaceSparsePresetId,
    setWorkspaceSparsePresets,
    setWorkspaceSparsePresetsError,
    setWorkspaceSparsePresetsLoaded,
    setWorkspaceSparseSaving,
    setWorkspaceSshConnecting,
    setWorkspaceSshState,
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
      !client ||
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
      const response = await client.sendRequest('repo.saveSparsePreset', {
        repo: `id:${workspaceCreateTargetRepo.id}`,
        ...(workspaceSparseDraft.presetId ? { id: workspaceSparseDraft.presetId } : {}),
        name: workspaceSparseDraftName,
        directories: workspaceSparseDraftParsed.directories
      })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const saved = (response.result as { preset?: SparsePreset }).preset
      if (!saved) {
        throw new Error('Failed to save sparse preset.')
      }
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
    client,
    tasksSupported,
    workspaceCreateTargetRepo,
    workspaceSparseDraft,
    workspaceSparseDraftName,
    workspaceSparseDraftParsed,
    workspaceSparsePresetId
  ])

  useEffect(() => {
    if (!tasksSupported || !client || !workspaceCreateDraft || !workspaceCreateTargetConnectionId) {
      setWorkspaceSshState(null)
      setWorkspaceSshConnecting(false)
      return
    }

    let stale = false
    void client
      .sendRequest('ssh.getState', { targetId: workspaceCreateTargetConnectionId })
      .then((response) => {
        if (stale) {
          return
        }
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const state = (response.result as { state?: SshConnectionState | null }).state ?? null
        setWorkspaceSshState(
          state ?? {
            targetId: workspaceCreateTargetConnectionId,
            status: 'disconnected',
            error: null,
            reconnectAttempt: 0
          }
        )
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
  }, [client, tasksSupported, workspaceCreateDraft, workspaceCreateTargetConnectionId])
  return Object.assign(model, {
    startNewWorkspaceSparsePreset,
    startEditWorkspaceSparsePreset,
    saveWorkspaceSparsePreset
  })
}

export type WorkspaceSparseActionsModel = ReturnType<typeof useMobileTasksWorkspaceSparseActions>
