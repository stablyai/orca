import { useState, type ReactNode } from 'react'
import type { TopLevelView } from '../../../shared/ui-chrome-types'
import { OverlayAllowedContext } from '@/lib/overlay-allowed-context'

export function AppWorkspaceShellTasksView({
  activeView,
  children
}: {
  activeView: TopLevelView
  children: ReactNode
}): React.JSX.Element | null {
  const isVisible = activeView === 'tasks'
  // Why: skip the Tasks bundle until the first visit; a ref latch would survive a discarded render.
  const [hasMountedTasksView, setHasMountedTasksView] = useState(false)
  if (isVisible && !hasMountedTasksView) {
    setHasMountedTasksView(true)
  }
  if (!hasMountedTasksView) {
    return null
  }

  return (
    <OverlayAllowedContext.Provider value={isVisible}>
      <div
        className={isVisible ? 'flex flex-1 min-w-0 min-h-0' : 'hidden flex-1 min-w-0 min-h-0'}
        hidden={!isVisible}
        inert={!isVisible}
        aria-hidden={!isVisible}
        data-app-workspace-shell-tasks-view=""
      >
        {children}
      </div>
    </OverlayAllowedContext.Provider>
  )
}

export function renderTasksView(activeView: TopLevelView, page: ReactNode): ReactNode {
  return <AppWorkspaceShellTasksView activeView={activeView}>{page}</AppWorkspaceShellTasksView>
}
