import { z } from 'zod'
import {
  CREDENTIAL_VAULT_METHOD,
  type CredentialVaultOperation
} from '../../../shared/rpc-contract/host-management/credential-vault-params'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  VAULT_FAILURE_REASONS,
  type ServerVaultTarget,
  type VaultResult
} from '../../../shared/secure-storage/credential-vault'
import { getRuntimeEnvironmentRegistryRoot } from '../../ipc/runtime-environments/catalog/runtime-environment-registry-root'
import { isRuntimeEnvironmentManuallyDisconnected } from '../../ipc/runtime-environments/connectivity/runtime-environment-manual-disconnect'
import { callRuntimeEnvironment } from '../../ipc/runtime-environments/requests/runtime-environment-transport-routing'

export const serverVaultTargetSchema = z.object({
  environmentId: z.string().min(1).max(256),
  pairingRevision: z.number().finite()
})
const remoteFailureSchema = z.object({
  ok: z.literal(false),
  reason: z.enum(VAULT_FAILURE_REASONS)
})

export async function callServerVault<T>(
  target: ServerVaultTarget,
  operation: CredentialVaultOperation,
  valueSchema: z.ZodType<T>
): Promise<VaultResult<T>> {
  try {
    const root = getRuntimeEnvironmentRegistryRoot()
    const environment = await resolveEnvironment(root, target.environmentId)
    if (
      environment.id !== target.environmentId ||
      isRuntimeEnvironmentManuallyDisconnected(environment.id)
    ) {
      return { ok: false, reason: 'unavailable' }
    }
    const response = await callRuntimeEnvironment(
      root,
      environment.id,
      CREDENTIAL_VAULT_METHOD,
      operation,
      undefined,
      target.pairingRevision
    )
    if (!response.ok) {
      switch (response.error.code) {
        case 'forbidden':
          return { ok: false, reason: 'forbidden' }
        case 'method_not_found':
          return { ok: false, reason: 'unsupported' }
        default:
          return { ok: false, reason: 'unavailable' }
      }
    }
    const result = z
      .union([remoteFailureSchema, z.object({ ok: z.literal(true), value: valueSchema })])
      .safeParse(response.result)
    return result.success ? result.data : { ok: false, reason: 'unavailable' }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}
