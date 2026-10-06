import {
  toRuntimeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { NotificationWorkspaceOwner } from '../../../shared/notification-source'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getPtyExecutionHost } from '../../../shared/terminal-execution-host'
import type { Tab } from '../../../shared/tab-types'
import type { AppState } from '@/store/types'
import type { PtyTransport } from '@/components/terminal-pane/pty-transport-types'
import { resolveTerminalTabPtyOwnership } from '@/lib/terminal-tab-for-pty-id'
import { resolveExactWorktreeRoute, routeForOwner } from '@/lib/worktree-owner-route'
import {
  findIndexedWorktreeOwner,
  findIndexedWorktreeOwnerForHost,
  findIndexedFolderWorkspaceOwner,
  findIndexedRepoOwner,
  findIndexedProjectGroupOwner,
  getCatalogOwnerHostId
} from '@/lib/worktree-runtime-owner-index'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner'

type SubjectOwnerState = WorktreeRuntimeOwnerState &
  Partial<
    Pick<
      AppState,
      'tabsByWorktree' | 'unifiedTabsByWorktree' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId'
    >
  >

export function notificationExecutionHostForOwner(
  owner: NotificationWorkspaceOwner | null
): ExecutionHostId | undefined {
  return owner?.runtimeEnvironmentId
    ? toRuntimeExecutionHostId(owner.runtimeEnvironmentId)
    : (owner?.executionHostId ?? undefined)
}

export function resolveNotificationTabOwner(
  state: WorktreeRuntimeOwnerState,
  tab: Pick<Tab, 'worktreeId' | 'executionHostId'>
): NotificationWorkspaceOwner | null {
  const hostId = parseExecutionHostId(tab.executionHostId)?.id
  const scope = parseWorkspaceKey(tab.worktreeId)
  if (scope?.type === 'folder') {
    const folder = findIndexedFolderWorkspaceOwner(
      state.folderWorkspaces,
      scope.folderWorkspaceId,
      hostId
    )
    if (!folder) {
      return explicitControllerOwner(hostId)
    }
    const group = findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId, hostId)
    return routeForOwner({
      hostId: getCatalogOwnerHostId({
        executionHostId: folder.executionHostId ?? group?.executionHostId,
        connectionId: folder.connectionId ?? group?.connectionId
      })
    })
  }
  const workspaceId = scope?.type === 'worktree' ? scope.worktreeId : tab.worktreeId
  const owner = hostId
    ? findIndexedWorktreeOwnerForHost(state.worktreesByRepo, workspaceId, hostId)
    : findIndexedWorktreeOwner(state.worktreesByRepo, workspaceId)
  if (!owner) {
    return explicitControllerOwner(hostId)
  }
  const repo = !owner.hostId ? findIndexedRepoOwner(state.repos, owner.repoId) : null
  const resolution = resolveExactWorktreeRoute(state, {
    ...owner,
    hostId: owner.hostId ?? (repo ? getCatalogOwnerHostId(repo) : hostId)
  })
  return resolution.kind === 'resolved' ? resolution.route : null
}

function explicitControllerOwner(
  hostId: ExecutionHostId | undefined
): NotificationWorkspaceOwner | null {
  // Local and paired tab stamps identify the controller even before its catalog arrives.
  return hostId === 'local' || hostId?.startsWith('runtime:') ? routeForOwner({ hostId }) : null
}

export function captureNotificationTransportOwner(
  transport: Pick<PtyTransport, 'getExecutionHostId' | 'getRuntimeEnvironmentId'> | undefined
): NotificationWorkspaceOwner | undefined {
  const executionHostId = transport?.getExecutionHostId?.() ?? null
  const runtimeEnvironmentId = transport?.getRuntimeEnvironmentId?.() ?? null
  return executionHostId || runtimeEnvironmentId
    ? { executionHostId, runtimeEnvironmentId }
    : undefined
}

export type TerminalNotificationBinding = {
  paneKey?: string
  ptyId?: string | null
  workspaceOwner?: NotificationWorkspaceOwner
}

export function resolveTerminalNotificationOwner(
  state: SubjectOwnerState,
  workspaceId: string,
  subject: TerminalNotificationBinding
): NotificationWorkspaceOwner | null {
  if (subject.workspaceOwner) {
    return subject.workspaceOwner
  }
  const pane = subject.paneKey ? parsePaneKey(subject.paneKey) : null
  const layout = pane ? state.terminalLayoutsByTabId?.[pane.tabId] : undefined
  const tabPtys = pane ? state.ptyIdsByTabId?.[pane.tabId] : undefined
  const ptyId =
    subject.ptyId ??
    (pane ? layout?.ptyIdsByLeafId?.[pane.leafId] : null) ??
    (tabPtys?.length === 1 ? tabPtys[0] : null)
  if (ptyId) {
    const binding = resolveTerminalTabPtyOwnership(
      {
        tabsByWorktree: state.tabsByWorktree ?? {},
        terminalLayoutsByTabId: state.terminalLayoutsByTabId ?? {},
        ptyIdsByTabId: state.ptyIdsByTabId ?? {}
      },
      workspaceId,
      ptyId
    )
    if (binding.kind !== 'owned') {
      return null
    }
    const transportHost = getPtyExecutionHost(ptyId)
    if (transportHost === 'foreign') {
      return null
    }
    // A currently bound, unprefixed PTY belongs to this client's IPC transport.
    const transportOwner = routeForOwner({ hostId: transportHost ?? 'local' })
    const workspaceOwner = resolveNotificationTabOwner(state, {
      worktreeId: workspaceId,
      executionHostId: transportHost ?? 'local'
    })
    return workspaceOwner &&
      workspaceOwner.runtimeEnvironmentId === transportOwner?.runtimeEnvironmentId &&
      (transportHost?.startsWith('runtime:') ||
        workspaceOwner.executionHostId === transportOwner?.executionHostId)
      ? workspaceOwner
      : transportOwner
  }
  const tab = state.unifiedTabsByWorktree?.[workspaceId]?.find(
    (candidate) =>
      candidate.contentType === 'terminal' &&
      (candidate.entityId === pane?.tabId || candidate.id === pane?.tabId)
  )
  return tab ? resolveNotificationTabOwner(state, tab) : null
}
