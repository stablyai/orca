import { paneSize, resolvePtyFirstSize, type PtyGridSize } from '../../../ipc/pty/pty-first-size'

export function terminalCreateSize(args: {
  workspaceId: string
  targetGroupId?: string
  activeGroupId?: string | null
  session: Parameters<typeof paneSize>[0]
  opts: Parameters<typeof paneSize>[1]
  singleGroupSize?: PtyGridSize
  groupSizes?: Record<string, PtyGridSize>
}) {
  const { workspaceId, targetGroupId, activeGroupId, session, opts, singleGroupSize, groupSizes } =
    args
  // The window's latest published active group is where its reveal places the tab.
  const groupId = targetGroupId ?? activeGroupId ?? session?.activeGroupIdByWorktree?.[workspaceId]
  // Unshown workspaces have no measured group; a single group can use the common workspace geometry.
  const singleGroup =
    (session?.tabGroups?.[workspaceId]?.length ?? 0) <= 1 ? singleGroupSize : undefined
  const group = groupId ? groupSizes?.[groupId] : undefined
  return resolvePtyFirstSize({ pane: paneSize(session, opts), group, singleGroup })
}
