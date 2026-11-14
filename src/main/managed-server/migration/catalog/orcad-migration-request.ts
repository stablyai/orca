import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../../../../shared/automations/automation-runtime-capabilities'
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import type { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY } from '../../../../shared/orcad-runtime-capabilities'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'

/** Missing capability/method is definite refusal; other failures require catalog re-read because a lost reply may hide staged state. */
export const ORCAD_MIGRATION_DESTINATION_UNSUPPORTED = 'orcad_migration_destination_unsupported'

/** Refuse older destinations that would silently strip extra agent arguments. */
export const ORCAD_MIGRATION_DESTINATION_EXTRA_AGENT_ARGS_UNSUPPORTED =
  'orcad_migration_destination_extra_agent_args_unsupported:Update Orca on this host to use extra arguments.'

/** Unsupported source kinds are refused before any staging request. */
export const ORCAD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED =
  'orcad_migration_destination_source_kind_unsupported:Update Orca on this host to move this project to it.'

export type CatalogRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  expectedRuntimeId?: string
}

export async function sendSupportedMigrationRequest(
  pairing: NonNullable<ReturnType<typeof parsePairingCode>>,
  method: string,
  params: unknown,
  options: CatalogRequestOptions,
  requiresExtraAgentArgs = false,
  requiredSourceCapability: string | null = null,
  assertCapabilities: (capabilities: readonly string[]) => void = () => {}
): Promise<RuntimeRpcResponse<unknown>> {
  const pairingConnection = pairedRuntimeConnectionFromOffer(pairing)
  const requestTimeoutMs = options.timeoutMs ?? 15_000
  const requestSignal = options.signal
  const response = await sendRemoteRuntimeRequestOnSocket<unknown>(
    pairingConnection,
    method,
    params,
    requestTimeoutMs,
    undefined,
    (status) => {
      if (!status.ok) {
        throw new Error(`orcad_migration_status_failed:${status.error.message}`)
      }
      if (
        options.expectedRuntimeId !== undefined &&
        status._meta?.runtimeId !== options.expectedRuntimeId
      ) {
        throw new Error('orcad_migration_destination_runtime_mismatch')
      }
      if (!status.result.capabilities?.includes(ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY)) {
        throw new Error(ORCAD_MIGRATION_DESTINATION_UNSUPPORTED)
      }
      if (
        requiresExtraAgentArgs &&
        !status.result.capabilities?.includes(AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY)
      ) {
        throw new Error(ORCAD_MIGRATION_DESTINATION_EXTRA_AGENT_ARGS_UNSUPPORTED)
      }
      if (
        requiredSourceCapability !== null &&
        !status.result.capabilities?.includes(requiredSourceCapability)
      ) {
        throw new Error(ORCAD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED)
      }
      assertCapabilities(status.result.capabilities ?? [])
    },
    requestSignal,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
    undefined,
    undefined
  )
  if (!response.ok && response.error.code === 'method_not_found') {
    throw new Error(ORCAD_MIGRATION_DESTINATION_UNSUPPORTED)
  }
  if (
    options.expectedRuntimeId !== undefined &&
    response._meta?.runtimeId !== options.expectedRuntimeId
  ) {
    throw new Error('orcad_migration_destination_runtime_mismatch')
  }
  return response
}
