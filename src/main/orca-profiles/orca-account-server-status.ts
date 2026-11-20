import type {
  OrcaAccountServerStatus,
  OrcaAccountStorage
} from '../../shared/orca-account-server-sign-in'
import type { OrcaProfileAuthStatus } from '../../shared/orca-profiles/orca-profiles'
import { getSecretStore } from '../../shared/secure-storage/secret-store'
import { sealedStorageRefusal } from './cloud-session/profile-cloud-session-sealing'

/** Plain text, unavailable, withheld and memory-only storage are refused; the host-key seal is
 * allowed with its warning shown. */
export function readOrcaAccountStorage(): OrcaAccountStorage {
  const refusal = sealedStorageRefusal()
  const sealing = refusal === null ? getSecretStore().describeSealing?.() : undefined
  if (refusal !== null || !sealing || sealing.kind === 'none') {
    return { kind: 'refused', reason: refusal ?? 'this host cannot seal credentials.' }
  }
  return sealing.kind === 'host-key'
    ? { kind: 'host-key', warning: sealing.warning }
    : { kind: 'os-keychain' }
}

export function toServerStatus(
  auth: OrcaProfileAuthStatus,
  storage: OrcaAccountStorage
): OrcaAccountServerStatus {
  const state =
    auth.state === 'connected'
      ? 'signed-in'
      : auth.state === 'local'
        ? 'signed-out'
        : auth.state === 'unconfigured'
          ? 'unconfigured'
          : 'reconnect-required'
  return {
    state,
    ...(auth.cloud
      ? {
          email: auth.cloud.email,
          displayName: auth.cloud.displayName,
          orgId: auth.cloud.activeOrgId,
          orgName: auth.cloud.activeOrgName
        }
      : {}),
    ...(auth.organizations ? { organizations: auth.organizations } : {}),
    ...(auth.capabilities ? { lastConfirmedAt: auth.capabilities.refreshedAt } : {}),
    ...(auth.credentialError ? { reason: auth.credentialError } : {}),
    storage
  }
}
