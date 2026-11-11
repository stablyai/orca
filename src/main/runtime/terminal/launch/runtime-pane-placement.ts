import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-pane-layout-tree'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'
import type { TerminalPaneAdmission } from '../../../persistence/terminal-topology/terminal-pane-admission'

type Spawn = NonNullable<RuntimePtyController['spawn']>
export type AdmittedSpawnArgs = Parameters<Spawn>[0] & {
  worktreeId: string
  tabId: string
  leafId: string
  /** The group a new tab joins; a split stays in its parent's. */
  groupId?: string
  afterTabId?: string
}

/** The pane its placement names: a new tab, or a split beside its parent pane. */
export function admissionFor(args: AdmittedSpawnArgs): TerminalPaneAdmission {
  const { worktreeId: workspace, tabId, leafId, placement } = args
  if (placement?.kind === 'split') {
    const { parentLeafId, direction } = placement
    return {
      type: 'splitPane',
      workspace,
      tabId,
      leafId: parentLeafId,
      direction,
      newLeafId: leafId
    }
  }
  const row = placement?.kind === 'new-tab' ? placement.row : undefined
  return {
    type: 'createTerminalTab',
    workspace,
    tabId,
    leafId,
    ...(args.groupId ? { groupId: args.groupId } : {}),
    ...(args.afterTabId ? { afterTabId: args.afterTabId } : {}),
    ...(args.groupSplit ? { split: args.groupSplit } : {}),
    ...(row?.viewMode ? { viewMode: row.viewMode } : {}),
    ...(row?.customTitle ? { title: row.customTitle } : {}),
    ...(args.cwd ||
    args.launchAgent ||
    (args.launchRuntime?.pty.shellOverride ?? args.shellOverride)
      ? {
          creation: {
            ...(args.cwd ? { startupCwd: args.cwd } : {}),
            ...(args.launchAgent ? { launchAgent: args.launchAgent } : {}),
            ...((args.launchRuntime?.pty.shellOverride ?? args.shellOverride)
              ? { shellOverride: args.launchRuntime?.pty.shellOverride ?? args.shellOverride }
              : {})
          }
        }
      : {})
  }
}

export function hostIdOf(args: AdmittedSpawnArgs): string | undefined {
  return args.connectionId ? toSshExecutionHostId(args.connectionId) : undefined
}

export function paneStillWritten(
  store: RuntimeStore | null | undefined,
  args: AdmittedSpawnArgs
): boolean {
  const session = store?.getWorkspaceSession?.(hostIdOf(args))
  const layout = session?.terminalLayoutsByTabId?.[args.tabId]
  return Boolean(
    session?.tabsByWorktree?.[args.worktreeId]?.some((tab) => tab.id === args.tabId) &&
    !session?.closedTerminalTabTombstonesByTabId?.[args.tabId] &&
    !session?.closedTerminalPanesByPaneKey?.[`${args.tabId}:${args.leafId}`] &&
    collectLeafIds(layout?.root).includes(args.leafId)
  )
}

export function preparedAdmissionFor(
  store: RuntimeStore | null | undefined,
  args: AdmittedSpawnArgs
): TerminalPaneAdmission {
  const admission = admissionFor(args)
  if (ORCA_LAYOUT_OWNER_IS_MAIN || admission.type !== 'createTerminalTab' || !admission.split) {
    return admission
  }
  const groups = store?.getWorkspaceSession?.(hostIdOf(args))?.tabGroups?.[args.worktreeId] ?? []
  const split = admission.split
  if (
    [split.besideGroupId, split.besideLastGroupId ?? split.besideGroupId].every((id) =>
      groups.some((group) => group.id === id)
    )
  ) {
    return admission
  }
  // Window-owned groups can precede their host mirror; the accepted view applies the caller's placement.
  const { split: _split, ...ordinary } = admission
  return ordinary
}
