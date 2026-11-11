import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'

export function useAppShortcutActions() {
  // One shallow action subscription avoids an equality check per action on every store mutation.
  return useAppStore(
    useShallow((s) => ({
      toggleSidebar: s.toggleSidebar,
      toggleRightSidebar: s.toggleRightSidebar,
      setRightSidebarOpen: s.setRightSidebarOpen,
      setRightSidebarTab: s.setRightSidebarTab,
      showRightSidebarFiles: s.showRightSidebarFiles,
      showRightSidebarSearch: s.showRightSidebarSearch,
      openDiffNotesSendMenuForActiveWorktree: s.openDiffNotesSendMenuForActiveWorktree
    }))
  )
}
