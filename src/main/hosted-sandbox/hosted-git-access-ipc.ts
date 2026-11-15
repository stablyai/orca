// LIVE-GIT-ACCESS: a GitHub App install made after an Orca Cloud workspace started, applied to the running
// VM (POST /v1/sandboxes/:id/git/access): the repo token goes into its live egress policy and its git gets
// the placeholder header, so pulls and pushes work without a restart. `applied` false says why not.
import { ipcMain } from 'electron'
import { HostedGitAccessResponseSchema } from '../../shared/hosted-sandbox/hosted-git-access-wire'
import {
  ORCA_CLOUD_WORKSPACE_CHANNELS as CH,
  type CloudWorkspaceTarget
} from '../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedSandboxConfig } from './hosted-sandbox-config'
import { createHostedSandboxRequest } from './hosted-sandbox-control-plane-client'
import { findCloudSandbox } from './cloud-workspace-target'
import { NOT_CLOUD, failure } from './hosted-workspace-runtime'
import { registerCloudShareHandlers } from './hosted-sandbox-share-ipc'

/** The handlers that call the control plane directly (no lifecycle client): share links and git access. */
export function registerCloudWorkspaceRequestHandlers(
  userDataPath: string,
  config: HostedSandboxConfig | null
): void {
  registerCloudShareHandlers(userDataPath, config)
  registerCloudGitAccessHandler(userDataPath, config)
}

/** Registered for every build; without a control plane it answers `not_cloud`. */
export function registerCloudGitAccessHandler(
  userDataPath: string,
  config: HostedSandboxConfig | null
): void {
  const call = config
    ? createHostedSandboxRequest({
        baseUrl: config.controlPlaneUrl,
        getAccessToken: config.getAccessToken,
        fetch: config.fetch
      })
    : null
  ipcMain.removeHandler(CH.refreshGitAccess)
  ipcMain.handle(CH.refreshGitAccess, async (_event, args: CloudWorkspaceTarget) => {
    const found = call ? findCloudSandbox(userDataPath, args) : null
    if (!call || !found) {
      return NOT_CLOUD
    }
    try {
      const answer = await call(
        'POST',
        `v1/sandboxes/${encodeURIComponent(found.sandboxId)}/git/access`,
        HostedGitAccessResponseSchema,
        { kind: 'control' }
      )
      return {
        ok: true,
        value: answer.applied ? { applied: true } : { applied: false, reason: answer.reason }
      }
    } catch (error) {
      return failure(error)
    }
  })
}
