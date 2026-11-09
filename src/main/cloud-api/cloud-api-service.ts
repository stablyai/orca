import { app } from 'electron'
// Orca Cloud API access for the desktop settings. Uses the same hosted control plane + session
// token as Orca Cloud sandboxes, so it is only on in builds that configure ORCA_CLOUD_SANDBOX_URL.
// Every call resolves to a CloudApiResult value; nothing throws across IPC and no token is returned.
import type {
  CloudApiAvailability,
  CloudApiErrorCode,
  CloudApiResult
} from '../../shared/cloud-api/cloud-api-types'
import { withCloudBuildDefaults } from '../cloud-build-defaults'
import { EnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { getHostedSandboxConfig } from '../hosted-sandbox/hosted-sandbox-config'
import { findCloudRuntime } from '../hosted-sandbox/hosted-workspace-runtime'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { CloudApiError, createCloudApiClient, type CloudApiClient } from './cloud-api-client'

let cached: { key: string; client: CloudApiClient; controlPlaneUrl: string } | null = null

export function classifyTokenError(error: unknown): CloudApiErrorCode {
  if (error instanceof EnvironmentProviderError) {
    return error.code === 'unauthorized' ? 'signed-out' : 'network'
  }
  return 'signed-out'
}

function resolveClient(): { client: CloudApiClient; controlPlaneUrl: string } | null {
  const userDataPath = app.getPath('userData')
  // Token caches are per profile *and* signed-in account: switching profiles, signing out or
  // signing in as someone else must never reuse the previous account's token.
  const profile = ensureActiveOrcaProfile(userDataPath).profile
  const profileKey = `${profile.id}:${profile.cloud?.userId ?? 'signed-out'}`
  if (cached?.key === profileKey) {
    return cached
  }
  const config = getHostedSandboxConfig(
    userDataPath,
    withCloudBuildDefaults(process.env),
    app.isPackaged
  )
  if (!config) {
    cached = null
    return null
  }
  cached = {
    key: profileKey,
    controlPlaneUrl: config.controlPlaneUrl,
    client: createCloudApiClient({
      controlPlaneUrl: config.controlPlaneUrl,
      getAccessToken: () => config.getAccessToken(),
      classifyTokenError
    })
  }
  return cached
}

export function getCloudApiAvailability(): CloudApiAvailability {
  const resolved = resolveClient()
  return resolved
    ? { status: 'ready', controlPlaneUrl: resolved.controlPlaneUrl }
    : { status: 'unconfigured' }
}

export async function callCloudApi<T>(
  run: (client: CloudApiClient) => Promise<T>
): Promise<CloudApiResult<T>> {
  const resolved = resolveClient()
  if (!resolved) {
    return { ok: false, error: 'unconfigured' }
  }
  try {
    return { ok: true, data: await run(resolved.client) }
  } catch (error) {
    if (error instanceof CloudApiError) {
      return {
        ok: false,
        error: error.code,
        ...(error.detail ? { detail: error.detail } : {}),
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {})
      }
    }
    // Unknown failures stay generic: their messages could carry request internals.
    return { ok: false, error: 'server' }
  }
}

/**
 * The desktop workspace (worktree) that runs on a given Orca Cloud sandbox, if this computer
 * has it (e.g. a routine run's workspace that was opened here before). Null otherwise.
 */
export function findLocalWorkspaceForSandbox(sandboxId: string): string | null {
  const userDataPath = app.getPath('userData')
  for (const runtime of listEphemeralVmRuntimes(userDataPath)) {
    if (runtime.recipe?.provider !== 'orca-cloud' || !runtime.workspaceId) {
      continue
    }
    if (findCloudRuntime(userDataPath, runtime.workspaceId)?.sandboxId === sandboxId) {
      return runtime.workspaceId
    }
  }
  return null
}
