import { paneSize, resolvePtyFirstSize, type PtyGridSize } from '../../../ipc/pty/pty-first-size'
import type { TerminalCreateOptions } from './terminal-create-options'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

export function terminalCreateGrid({
  workspaceId,
  launchOpts,
  opts,
  session,
  mobileActiveGroupId,
  singleGroupWorkspaceGridSize,
  terminalGroupGridSizes
}: {
  workspaceId: string
  launchOpts: TerminalCreateOptions
  opts: TerminalCreateOptions
  session: WorkspaceSessionState | null | undefined
  mobileActiveGroupId: string | null | undefined
  singleGroupWorkspaceGridSize: PtyGridSize | undefined
  terminalGroupGridSizes: Record<string, PtyGridSize> | undefined
}): PtyGridSize {
  // The window's latest published active group is where its reveal places the tab.
  const groupId =
    launchOpts.targetGroupId ??
    mobileActiveGroupId ??
    session?.activeGroupIdByWorktree?.[workspaceId]
  // Unshown workspaces have no measured group; a single group can use the common workspace geometry.
  const singleGroup =
    (session?.tabGroups?.[workspaceId]?.length ?? 0) <= 1 ? singleGroupWorkspaceGridSize : undefined
  const group = groupId ? terminalGroupGridSizes?.[groupId] : undefined
  return resolvePtyFirstSize({
    pane: launchOpts.initialSize ?? paneSize(session, opts),
    group,
    singleGroup
  })
}
