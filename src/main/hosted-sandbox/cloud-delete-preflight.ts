// Before Delete removes an Orca Cloud workspace's row, prove the signed-in identity can reach its
// sandbox. A row removed first and a destroy that then fails leaves a billed VM nobody can see.
import { ephemeralVmFailure, type EphemeralVmFailure } from '../../shared/ephemeral-vm-failure-copy'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { cloudSandboxesByEnvironment } from './hosted-remote-desktop'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'

/** `asleep`: the sandbox has no running server to remove its checkout; destroying it is enough. */
export type CloudDeletePreflight =
  | { ok: true; asleep?: boolean }
  | ({ ok: false } & EphemeralVmFailure)

const ASLEEP_STATUSES = new Set(['suspending', 'suspended', 'archived'])

export function cloudSandboxIdForEnvironment(
  userDataPath: string,
  runtimeEnvironmentId: string
): string | undefined {
  return cloudSandboxesByEnvironment(userDataPath).get(runtimeEnvironmentId)
}

export async function preflightCloudWorkspaceDelete(
  sandboxId: string | undefined,
  client: Pick<HostedSandboxControlPlaneClient, 'get'> | null
): Promise<CloudDeletePreflight> {
  if (!sandboxId) {
    // Not an Orca Cloud workspace (or its sandbox is already cleaned up): nothing to prove.
    return { ok: true }
  }
  if (!client) {
    return { ok: false, ...ephemeralVmFailure('cloudUnavailable') }
  }
  try {
    const view = await client.get(sandboxId)
    return ASLEEP_STATUSES.has(view.status) ? { ok: true, asleep: true } : { ok: true }
  } catch (error) {
    if (isEnvironmentProviderError(error, 'not_found')) {
      return { ok: false, ...ephemeralVmFailure('cloudDeleteNotConfirmed') }
    }
    if (isEnvironmentProviderError(error, 'unauthorized')) {
      return { ok: false, ...ephemeralVmFailure('cloudSignInRequired') }
    }
    // Fail closed: deleting the row without reaching Orca Cloud could orphan a billed VM.
    return { ok: false, ...ephemeralVmFailure('cloudUnavailable') }
  }
}
