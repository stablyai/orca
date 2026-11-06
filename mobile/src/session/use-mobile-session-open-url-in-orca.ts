import { useMemo } from 'react'
import type { MobileSessionController } from './use-mobile-session-controller'

export function useMobileSessionOpenUrlInOrca(
  controller: MobileSessionController
): ((url: string) => void) | undefined {
  const { client, handleCreateBrowserRef, isFloatingWorkspaceRoute, browserScreencastSupported } =
    controller
  // Why: a browser tab needs a real worktree and a connected host known to stream it; elsewhere
  // only the phone's browser is offered, so the sheet never shows a choice that would refuse.
  const canOpenUrlInOrca =
    client !== null &&
    controller.presentedConnState === 'connected' &&
    !isFloatingWorkspaceRoute &&
    browserScreencastSupported === true
  return useMemo(
    () =>
      canOpenUrlInOrca ? (url: string) => void handleCreateBrowserRef.current?.(url) : undefined,
    [canOpenUrlInOrca, handleCreateBrowserRef]
  )
}
