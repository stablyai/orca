// PAIRED-STATUS: which sandbox a window's cloud workspace id means. This desktop's own runtime
// record first, else a PAIRED server (a "<name> (cloud)" pairing) that is bound to a sandbox. Only
// bound pairings answer, so a window can never name an arbitrary sandbox.
import { ipcMain } from 'electron'
import { cloudPairedSandboxesByEnvironment } from '../cloud-workspaces/cloud-paired-environment-ids'
import {
  ORCA_CLOUD_WORKSPACE_CHANNELS as CH,
  type CloudWakeProgressEvent,
  type CloudWorkspaceResult,
  type CloudWorkspaceTarget
} from '../../shared/hosted-sandbox/cloud-workspace-api'
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'
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

/**
 * PAIRED-WAKE (2/2): Restart for a PAIRED workspace (no runtime record here to re-pair). The control
 * plane reboots the same disk; the bound server's dead connection is dropped so it reconnects at
 * once. Reports the same waking → connecting → ready / failed progress as an owned restart.
 */
export async function restartPairedCloudSandbox(args: {
  workspaceId: string
  sandboxId: string
  client: Pick<HostedSandboxControlPlaneClient, 'restart'>
  emit: (event: Omit<CloudWakeProgressEvent, 'at'>) => void
  invalidate?: (environmentId: string) => Promise<void>
}): Promise<CloudWorkspaceResult<null>> {
  const { workspaceId, sandboxId, emit } = args
  const invalidate = args.invalidate ?? invalidateRuntimeEnvironmentTransport
  const startedAt = Date.now()
  emit({ workspaceId, phase: 'waking', source: 'restart', startedAt })
  try {
    await args.client.restart(sandboxId)
    emit({ workspaceId, phase: 'connecting', source: 'restart', startedAt })
    for (const [environmentId, bound] of cloudPairedSandboxesByEnvironment()) {
      if (bound === sandboxId) {
        await invalidate(environmentId).catch(() => undefined)
      }
    }
    emit({ workspaceId, phase: 'ready', source: 'restart', startedAt })
    return { ok: true, value: null }
  } catch (error) {
    emit({
      workspaceId,
      phase: 'failed',
      source: 'restart',
      startedAt,
      message: error instanceof Error ? error.message : String(error)
    })
    return failure(error)
  }
}

/** Restart for a workspace with no runtime record here: a bound PAIRED sandbox, else not cloud. */
export function restartPairedOrNotCloud(
  deps: { userDataPath: string; client: Pick<HostedSandboxControlPlaneClient, 'restart'> },
  args: CloudWorkspaceTarget,
  emit: (event: Omit<CloudWakeProgressEvent, 'at'>) => void
): Promise<CloudWorkspaceResult<null>> | typeof NOT_CLOUD {
  const paired = findCloudSandbox(deps.userDataPath, args)
  return paired
    ? restartPairedCloudSandbox({
        workspaceId: args.workspaceId,
        sandboxId: paired.sandboxId,
        client: deps.client,
        emit
      })
    : NOT_CLOUD
}
