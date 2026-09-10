import type { HostTaskLinearStatus } from './host-task-runtime-payloads'

/** The host answers `linear.status` and `linear.selectWorkspace` with the same connection
 *  status, and older hosts omit fields, so read it defensively in one place. */
export function normalizeLinearStatus(value: unknown): HostTaskLinearStatus {
  const status = (value ?? {}) as Partial<HostTaskLinearStatus>
  return {
    connected: status.connected === true,
    workspaces: Array.isArray(status.workspaces) ? status.workspaces : [],
    selectedWorkspaceId: status.selectedWorkspaceId ?? null,
    activeWorkspaceId: status.activeWorkspaceId ?? null
  }
}
