import type { RpcClient } from '../transport/rpc-client'
import { readMobileRuntimeHostPlatform } from '../transport/mobile-runtime-host-platform'
import {
  newTabFolderWorkspaceListRead,
  newTabHostStatusRead,
  newTabProjectGroupListRead,
  newTabRepoPlacementListRead
} from './mobile-session-read-operations'

/**
 * Whether a host that discards the workspace id still answers for this folder: only when every
 * repo, project group and folder it holds runs on that host, and the host is not Windows (where a
 * folder may run in WSL). Placement is never inferred here; anything less certain is the caller's
 * "update the desktop" answer.
 */
export async function legacyHostAnswersForFolder(
  client: RpcClient,
  worktreeId: string
): Promise<boolean> {
  const [repos, groups, folders, status] = await Promise.all([
    newTabRepoPlacementListRead.request(client).then(newTabRepoPlacementListRead.interpret),
    newTabProjectGroupListRead.request(client).then(newTabProjectGroupListRead.interpret),
    newTabFolderWorkspaceListRead.request(client).then(newTabFolderWorkspaceListRead.interpret),
    newTabHostStatusRead.request(client).then(newTabHostStatusRead.interpret)
  ])
  if (!repos.accepted || !groups.accepted || !folders.accepted || !status.accepted) {
    return false
  }
  if (repos.value === null || groups.value === null || folders.value === null) {
    return false
  }
  const hostPlatform = readMobileRuntimeHostPlatform(status.value)
  const folderWorkspaceId = worktreeId.slice('folder:'.length)
  return (
    hostPlatform !== null &&
    hostPlatform !== 'win32' &&
    folders.value.some((folder) => isRecord(folder) && folder.id === folderWorkspaceId) &&
    [...repos.value, ...groups.value, ...folders.value].every(runsOnHost)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function runsOnHost(row: unknown): boolean {
  if (!isRecord(row)) {
    return false
  }
  const { connectionId, executionHostId } = row
  // Why fail closed: a malformed placement value is unknown placement, not local.
  const noConnection =
    connectionId === undefined ||
    connectionId === null ||
    (typeof connectionId === 'string' && connectionId.trim() === '')
  const localHost =
    executionHostId === undefined || executionHostId === null || executionHostId === 'local'
  return noConnection && localHost
}
