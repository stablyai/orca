// Before Delete removes an Orca Cloud workspace's row, prove the signed-in identity can reach its
// sandbox. A row removed first and a destroy that then fails leaves a billed VM nobody can see.
import { ephemeralVmFailure, type EphemeralVmFailure } from '../../shared/ephemeral-vm-failure-copy'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { cloudSandboxesByEnvironment } from './hosted-remote-desktop'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'

/**
 * `asleep`: no running server to remove its checkout; destroying the sandbox takes the disk.
 * `gone`: Orca Cloud already destroyed it (or it never started); only the row is left.
 * `unreachable` (EP-8): running, but this computer can't reach its server (its pairing was revoked,
 * e.g. by an owner change, or it doesn't answer). Like asleep: Delete goes through Orca Cloud.
 */
export type CloudDeletePreflight =
  | { ok: true; asleep?: boolean; gone?: boolean; unreachable?: 'rejected' | 'no_answer' }
  | ({ ok: false } & EphemeralVmFailure)

/** Can this computer reach the workspace's server right now? A short probe, never a wake. */
export type CloudServerProbe = () => Promise<'ok' | 'rejected' | 'no_answer'>

const ASLEEP_STATUSES = new Set(['suspending', 'suspended', 'archived'])
const GONE_STATUSES = new Set(['destroying', 'destroyed', 'failed'])

export function cloudSandboxIdForEnvironment(
  userDataPath: string,
  runtimeEnvironmentId: string
): string | undefined {
  return cloudSandboxesByEnvironment(userDataPath).get(runtimeEnvironmentId)
}

export async function preflightCloudWorkspaceDelete(
  sandboxId: string | undefined,
  client: Pick<HostedSandboxControlPlaneClient, 'get'> | null,
  probe?: CloudServerProbe
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
    if (GONE_STATUSES.has(view.status)) {
      return { ok: true, gone: true }
    }
    if (ASLEEP_STATUSES.has(view.status)) {
      return { ok: true, asleep: true }
    }
    // Running on Orca Cloud: a Delete through a server this computer can't reach would wait forever.
    const reach = probe ? await probe().catch(() => 'no_answer' as const) : 'ok'
    return reach === 'ok' ? { ok: true } : { ok: true, unreachable: reach }
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
