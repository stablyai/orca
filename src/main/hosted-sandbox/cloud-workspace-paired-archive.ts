// PAIRED-ARCHIVE: Archive and Unarchive for a PAIRED cloud workspace (a "<name> (cloud)" server bound
// to a sandbox; no runtime record here). The same control-plane calls as an owned archive, minus
// what only an owned workspace has on this computer: its runtime record (no status to flip), its
// synced copy (none is kept for a paired one) and its cached checkouts (main never captures them).
import { cloudPairedSandboxesByEnvironment } from '../cloud-workspaces/cloud-paired-environment-ids'
import type {
  CloudWakeProgressEvent,
  CloudWorkspaceResult,
  CloudWorkspaceTarget
} from '../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedArchivePullRequest } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'
import { failQueuedCloudPrompts } from './cloud-offline-seam'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { wakeBillingDenial } from './hosted-environment-provider'
import { NOT_CLOUD, failure } from './hosted-workspace-runtime'
import { findCloudSandbox } from './cloud-workspace-target'

type Deps = {
  userDataPath: string
  client: Pick<HostedSandboxControlPlaneClient, 'archive' | 'unarchive'>
  invalidate?: (environmentId: string) => Promise<void>
}

/** The control plane's archive caps (matching the owned path). */
const MAX_PULL_REQUESTS = 50

/** The archive request: the workspace (a paired one also names its server) and its PRs. */
export type CloudArchiveArgs = CloudWorkspaceTarget & { pullRequests?: HostedArchivePullRequest[] }

/** Archive a bound PAIRED sandbox, else not cloud. The window has already put it to sleep. */
export async function archivePairedOrNotCloud(
  deps: Deps,
  args: CloudArchiveArgs
): Promise<CloudWorkspaceResult<null>> {
  const paired = findCloudSandbox(deps.userDataPath, args)
  if (!paired) {
    return NOT_CLOUD
  }
  try {
    await deps.client.archive(
      paired.sandboxId,
      args.pullRequests?.length
        ? { pullRequests: args.pullRequests.slice(0, MAX_PULL_REQUESTS) }
        : {}
    )
    failQueuedCloudPrompts([args.workspaceId], 'The workspace was archived before this was sent.')
    return { ok: true, value: null }
  } catch (error) {
    return failure(error)
  }
}

/**
 * Unarchive a bound PAIRED sandbox, else not cloud. The control plane resumes the disk; the bound
 * server's dead connection is dropped so it reconnects at once, and the window then runs its wake.
 * A refusal reports the same failed progress (with the billing denial) as an owned unarchive.
 */
export async function unarchivePairedOrNotCloud(
  deps: Deps,
  args: CloudWorkspaceTarget,
  emit: (event: Omit<CloudWakeProgressEvent, 'at'>) => void
): Promise<CloudWorkspaceResult<null>> {
  const paired = findCloudSandbox(deps.userDataPath, args)
  if (!paired) {
    return NOT_CLOUD
  }
  const { workspaceId } = args
  const startedAt = Date.now()
  emit({ workspaceId, phase: 'waking', source: 'unarchive', startedAt })
  try {
    await deps.client.unarchive(paired.sandboxId)
    const invalidate = deps.invalidate ?? invalidateRuntimeEnvironmentTransport
    for (const [environmentId, bound] of cloudPairedSandboxesByEnvironment()) {
      if (bound === paired.sandboxId) {
        await invalidate(environmentId).catch(() => undefined)
      }
    }
    return { ok: true, value: null }
  } catch (error) {
    emit({
      workspaceId,
      phase: 'failed',
      source: 'unarchive',
      startedAt,
      message: error instanceof Error ? error.message : String(error),
      ...wakeBillingDenial(error)
    })
    return failure(error)
  }
}
