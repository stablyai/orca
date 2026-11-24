import { useMemo } from 'react'
import type { MobileSessionController } from '../../session/use-mobile-session-controller'

/**
 * Opens a link as a browser tab in this workspace, or undefined where only the phone's browser fits.
 * A browser tab needs a real worktree and a connected host known to stream it, so the sheet never
 * shows a choice that would refuse.
 */
export function useOpenUrlInOrca(
  controller: Pick<
    MobileSessionController,
    | 'client'
    | 'presentedConnState'
    | 'isFloatingWorkspaceRoute'
    | 'browserScreencastSupported'
    | 'handleCreateBrowserRef'
  >
): ((url: string) => void) | undefined {
  const { handleCreateBrowserRef } = controller
  const canOpen =
    controller.client !== null &&
    controller.presentedConnState === 'connected' &&
    !controller.isFloatingWorkspaceRoute &&
    controller.browserScreencastSupported === true
  return useMemo(
    () => (canOpen ? (url: string) => void handleCreateBrowserRef.current?.(url) : undefined),
    [canOpen, handleCreateBrowserRef]
  )
}
