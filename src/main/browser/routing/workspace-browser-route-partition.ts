// Every main-hosted page in an SSH workspace reaches the host's localhost through this one route step.
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  classifySshWorkspaceBrowserRouteError,
  resolveSshWorkspaceBrowserRouteEligibility
} from '../../../shared/ssh-workspace-browser-route-eligibility'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { listEnvironments } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getRuntimeEnvironmentRegistryRoot } from '../../ipc/runtime-environments/runtime-environment-registry-root'
import { BrowserError } from '../browser-error'

type WorkspaceBrowserRouteSettings = Pick<
  GlobalSettings,
  | 'browserSshWorkspaceRoutingEnabled'
  | 'browserSshWorkspaceRoutingDisabledTargetIds'
  | 'browserSshWorkspaceRoutingProbeSkippedTargetIds'
>

/** Proxy-verified partition for a registered SSH target; renderer panes and offscreen pages share it. */
export async function prepareSshWorkspaceBrowserPartition(input: {
  targetId: string
  browserProfileId: string
  expectedSshTargetGeneration?: unknown
  skipProbe?: boolean
}): Promise<{ partition: string }> {
  const [{ getSshConnectionStore }, { requireLocalSshBrowserRouteTarget }, partitions] =
    await Promise.all([
      import('../../ipc/ssh/ssh'),
      import('./local-host-partitions/local-ssh-browser-route'),
      import('./local-host-partitions/local-ssh-browser-partitions')
    ])
  requireLocalSshBrowserRouteTarget(
    getSshConnectionStore()?.getTarget(input.targetId),
    input.expectedSshTargetGeneration
  )
  return partitions.prepareLocalSshBrowserPartition({
    targetId: input.targetId,
    browserProfileId: input.browserProfileId,
    skipProbe: input.skipProbe
  })
}

/** Null when the workspace's pages use the profile's own egress; a routed host never falls back to local egress. */
export async function prepareWorkspaceBrowserRoutePartition(input: {
  executionHostId: string
  browserProfileId: string
  settings: WorkspaceBrowserRouteSettings
}): Promise<string | null> {
  if (input.settings.browserSshWorkspaceRoutingEnabled === false) {
    return null
  }
  const eligibility = resolveSshWorkspaceBrowserRouteEligibility(
    input.executionHostId,
    input.settings,
    // Only a paired-runtime host names its SSH target through the environment registry.
    parseExecutionHostId(input.executionHostId)?.kind === 'runtime'
      ? listEnvironments(getRuntimeEnvironmentRegistryRoot())
      : undefined
  )
  if (!eligibility?.eligible) {
    return null
  }
  const { targetId, expectedSshTargetGeneration } = eligibility
  try {
    const { partition } = await prepareSshWorkspaceBrowserPartition({
      targetId,
      browserProfileId: input.browserProfileId,
      expectedSshTargetGeneration,
      skipProbe: input.settings.browserSshWorkspaceRoutingProbeSkippedTargetIds?.includes(targetId)
    })
    return partition
  } catch (error) {
    throw new BrowserError('browser_error', workspaceRouteFailureMessage(error))
  }
}

function workspaceRouteFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const kind = classifySshWorkspaceBrowserRouteError(message)
  if (kind === 'forwarding-blocked') {
    return "This SSH host doesn't allow port forwarding, so Orca can't load its local pages here. Open the page in your system browser."
  }
  if (kind === 'ssh-unavailable') {
    return "This workspace's SSH host isn't connected, so Orca can't load its local pages yet. Reconnect the host and try again."
  }
  return `Orca couldn't route this page through the workspace's SSH host (${message}). Open the page in your system browser.`
}
