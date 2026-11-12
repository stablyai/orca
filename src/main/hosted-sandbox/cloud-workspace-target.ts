// PAIRED-STATUS: which sandbox a window's cloud workspace id means. This desktop's own runtime
// record first, else a PAIRED server (a "<name> (cloud)" pairing) that is bound to a sandbox. Only
// bound pairings answer, so a window can never name an arbitrary sandbox.
import { ipcMain } from 'electron'
import { cloudPairedSandboxesByEnvironment } from '../cloud-workspaces/cloud-paired-environment-ids'
import {
  ORCA_CLOUD_WORKSPACE_CHANNELS as CH,
  type CloudWorkspaceTarget
} from '../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { NOT_CLOUD, failure, findCloudRuntime, type CloudRuntime } from './hosted-workspace-runtime'

export function findCloudSandbox(
  userDataPath: string,
  args: CloudWorkspaceTarget
): { sandboxId: string; owned: CloudRuntime | null } | null {
  const owned = findCloudRuntime(userDataPath, args.workspaceId)
  if (owned) {
    return { sandboxId: owned.sandboxId, owned }
  }
  const paired =
    typeof args.environmentId === 'string' && args.environmentId
      ? cloudPairedSandboxesByEnvironment().get(args.environmentId)
      : undefined
  return paired ? { sandboxId: paired, owned: null } : null
}

/** "Archived" panel details (snapshot TTL, PRs), for an owned or paired cloud workspace. */
export function registerCloudArchiveInfoHandler(
  userDataPath: string,
  client: Pick<HostedSandboxControlPlaneClient, 'archiveInfo'>
): void {
  ipcMain.handle(CH.getArchive, async (_event, args: CloudWorkspaceTarget) => {
    const found = findCloudSandbox(userDataPath, args)
    if (!found) {
      return NOT_CLOUD
    }
    try {
      return { ok: true, value: await client.archiveInfo(found.sandboxId) }
    } catch (error) {
      return failure(error)
    }
  })
}
