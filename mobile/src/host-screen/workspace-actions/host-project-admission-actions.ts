import { useCallback } from 'react'
import type { MobileWorkspaceRepo } from '../../components/new-worktree-modal-types'
import type { Worktree } from '../../worktree/workspace-list-types'

type FetchWorktrees = (options?: { allowDuringModal?: boolean }) => Promise<Worktree[] | undefined>

// Desktop parity for the standalone Add project: the handoff lands on the added repo's
// default checkout (main worktree), never a create-workspace form. A catalog with no main
// row for the repo leaves the user on the list, which by then shows the new project.
export function useHostProjectAddedHandoff(args: {
  fetchWorktrees: FetchWorktrees
  openWorktreeSession: (worktree: Worktree) => void
}): (repo: MobileWorkspaceRepo) => Promise<void> {
  const { fetchWorktrees, openWorktreeSession } = args
  return useCallback(
    async (repo: MobileWorkspaceRepo) => {
      const confirmed = await fetchWorktrees({ allowDuringModal: true })
      const defaultCheckout = confirmed?.find(
        (worktree) => worktree.repoId === repo.id && worktree.isMainWorktree
      )
      if (defaultCheckout) {
        openWorktreeSession(defaultCheckout)
      }
    },
    [fetchWorktrees, openWorktreeSession]
  )
}

// Why: hosts without the add-project capability never list it, so the + goes straight
// to the create form there — a one-row sheet would be an extra tap for nothing.
export function usePlusActionSheet(args: {
  addProjectSupported: boolean
  openNewWorktreeModal: () => void
  setShowAddProject: (visible: boolean) => void
  setShowPlusActionSheet: (visible: boolean) => void
}): { openAddProject: () => void; openPlusActionSheet: () => void } {
  const { addProjectSupported, openNewWorktreeModal, setShowAddProject, setShowPlusActionSheet } =
    args
  const openPlusActionSheet = useCallback(() => {
    if (addProjectSupported) {
      setShowPlusActionSheet(true)
      return
    }
    openNewWorktreeModal()
  }, [addProjectSupported, openNewWorktreeModal, setShowPlusActionSheet])

  const openAddProject = useCallback(() => {
    if (addProjectSupported) {
      setShowAddProject(true)
    }
  }, [addProjectSupported, setShowAddProject])

  return { openAddProject, openPlusActionSheet }
}
