import { useCallback } from 'react'
import { MOBILE_ADD_PROJECT_RUNTIME_CAPABILITY } from '../../../../src/shared/remote-runtime/protocol/mobile-runtime-capabilities'
import type { HostScreenState } from '../use-host-screen-state'

export function useHostAddProjectActions(args: {
  hostCapabilities: readonly string[]
  setNewWorktreeInitialRepoId: HostScreenState['setNewWorktreeInitialRepoId']
  setNewWorktreeVisible: HostScreenState['setNewWorktreeVisible']
  setShowAddProject: HostScreenState['setShowAddProject']
}) {
  const {
    hostCapabilities,
    setNewWorktreeInitialRepoId,
    setNewWorktreeVisible,
    setShowAddProject
  } = args
  const openNewWorktreeForRepo = useCallback(
    (repoId?: string) => {
      setNewWorktreeInitialRepoId(repoId ?? null)
      setNewWorktreeVisible(true)
    },
    [setNewWorktreeInitialRepoId, setNewWorktreeVisible]
  )
  const closeNewWorktreeModal = useCallback(() => {
    setNewWorktreeVisible(false)
    setNewWorktreeInitialRepoId(null)
  }, [setNewWorktreeInitialRepoId, setNewWorktreeVisible])
  // Older hosts refuse the phone's repo.add/create/clone, so + keeps opening New Workspace directly there.
  const addProjectSupported = hostCapabilities.includes(MOBILE_ADD_PROJECT_RUNTIME_CAPABILITY)
  const openCreateMenu = useCallback(
    () => (addProjectSupported ? setShowAddProject : setNewWorktreeVisible)(true),
    [addProjectSupported, setNewWorktreeVisible, setShowAddProject]
  )
  const closeAddProject = useCallback(() => setShowAddProject(false), [setShowAddProject])
  return {
    addProjectSupported,
    closeAddProject,
    closeNewWorktreeModal,
    openCreateMenu,
    openNewWorktreeForRepo
  }
}
