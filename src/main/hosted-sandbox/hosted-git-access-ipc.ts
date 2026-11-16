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
import {
  hostedSandboxIdForEnvironment,
  registerCloudShareHandlers
} from './hosted-sandbox-share-ipc'

/** The handlers that call the control plane directly (no lifecycle client): share links and git access. */
export function registerCloudWorkspaceRequestHandlers(
  userDataPath: string,
  config: HostedSandboxConfig | null
): void {
  registerCloudShareHandlers(userDataPath, config)
  registerCloudGitAccessHandler(userDataPath, config)
}

/**
 * A sidebar workspace (owned or paired), or for the create wizard (CREATE-GH-STEP) before it has
 * one: the create's server environment (owned runtime record) or a GitHub-only create's sandbox id.
 */
type CloudGitAccessTarget =
  | CloudWorkspaceTarget
  | { environmentId: string }
  | { sandboxId: string }

const SANDBOX_ID = /^[A-Za-z0-9_]{1,64}$/

export function resolveGitAccessSandbox(
  userDataPath: string,
  args: CloudGitAccessTarget | undefined
): string | null {
  if (!args || typeof args !== 'object') {
    return null
  }
  if ('sandboxId' in args) {
    // The control plane's owner check is the real guard; this only refuses malformed ids.
    return typeof args.sandboxId === 'string' && SANDBOX_ID.test(args.sandboxId)
      ? args.sandboxId
      : null
  }
  if ('workspaceId' in args) {
    return typeof args.workspaceId === 'string'
      ? (findCloudSandbox(userDataPath, args)?.sandboxId ?? null)
      : null
  }
  if (typeof args.environmentId !== 'string' || !args.environmentId) {
    return null
  }
  return (
    hostedSandboxIdForEnvironment(userDataPath, args.environmentId) ??
    findCloudSandbox(userDataPath, { workspaceId: '', environmentId: args.environmentId })
      ?.sandboxId ??
    null
  )
}

/** Registered for every build; without a control plane it answers `not_cloud`. */
function registerCloudGitAccessHandler(
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
  ipcMain.handle(CH.refreshGitAccess, async (_event, args?: CloudGitAccessTarget) => {
    const sandboxId = call ? resolveGitAccessSandbox(userDataPath, args) : null
    if (!call || !sandboxId) {
      return NOT_CLOUD
    }
    try {
      const answer = await call(
        'POST',
        `v1/sandboxes/${encodeURIComponent(sandboxId)}/git/access`,
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
