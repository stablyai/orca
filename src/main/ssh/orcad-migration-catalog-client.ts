import { z } from 'zod'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import {
  parseOrcadMigrationCatalogAbortResult,
  parseOrcadMigrationCatalogState
} from '../../shared/orcad-migration/orcad-migration-catalog-state'
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'
import {
  parseOrcadMigrationSnapshotChunkResult,
  type OrcadMigrationSnapshotChunkRequest,
  type OrcadMigrationSnapshotChunkResult
} from '../../shared/orcad-migration/orcad-migration-scrollback'
import {
  findUnsupportedMigrationBlobKind,
  orcadMigrationBlobKindUnsupportedBlocker,
  parseOrcadMigrationBlobChunkResult,
  type OrcadMigrationBlobChunkRequest,
  type OrcadMigrationBlobChunkResult,
  type OrcadMigrationBlobDescriptor
} from '../../shared/orcad-migration/orcad-migration-blob-transfer'
import { parsePairingCode } from '../../shared/pairing'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../shared/remote-runtime-client'
import { assertOrcadMigrationRequestFits } from './orcad-migration-manifest-export'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { hasExtraAgentArgs } from '../../shared/automation-extra-agent-args'
import { requiredOrcadMigrationSourceCapability } from '../../shared/orcad-migration/orcad-migration-source-kind'
import type { OrcadServerRepository } from './orcad-migration-repository-link'

type OrcadCatalogMigrationOperation = 'abort' | 'commit' | 'stage' | 'state'

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

const METHOD_BY_OPERATION: Record<OrcadCatalogMigrationOperation, string> = {
  abort: 'orcad.migration.abortCatalog',
  commit: 'orcad.migration.commitCatalog',
  stage: 'orcad.migration.stageCatalog',
  state: 'orcad.migration.catalogState'
}

export function stageRemoteOrcadMigrationCatalog(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'stage', manifest, options)
}

/** Expected blobs make the destination refuse incomplete commits. */
export async function commitRemoteOrcadMigrationCatalog(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions & {
    expectedBlobs?: readonly OrcadMigrationBlobDescriptor[]
  } = {}
): Promise<OrcadMigrationCatalogState> {
  const result = await request(pairingCode, 'commit', manifest, options, options.expectedBlobs)
  return parseOrcadMigrationCatalogState(result, manifest)
}

export function readRemoteOrcadMigrationCatalogState(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'state', manifest, options)
}

export async function abortRemoteOrcadMigrationCatalog(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationCatalogAbortResult> {
  const result = await request(pairingCode, 'abort', manifest, options)
  const parsed = parseOrcadMigrationCatalogAbortResult(result, manifest)
  // Older already-absent replies prove no durability, unlike real aborts.
  if (parsed.state === 'absent' && !parsed.aborted && parsed.durableAbsent !== true) {
    throw new Error('orcad_migration_abort_durability_unverifiable:destination_update_required')
  }
  return parsed
}

export async function stageRemoteOrcadMigrationSnapshotChunk(
  pairingCode: string,
  request: OrcadMigrationSnapshotChunkRequest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationSnapshotChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(
    pairing,
    'orcad.migration.stageSnapshotChunk',
    request,
    options
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_snapshot_failed:${response.error.message}`)
  }
  return parseOrcadMigrationSnapshotChunkResult(response.result, request)
}

export async function stageRemoteOrcadMigrationBlobChunk(
  pairingCode: string,
  request: OrcadMigrationBlobChunkRequest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationBlobChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(
    pairing,
    'orcad.migration.stageBlobChunk',
    request,
    options,
    false,
    null,
    // Recheck every request so a downgraded destination cannot stage an unsupported blob kind.
    (capabilities) => {
      const unsupported = findUnsupportedMigrationBlobKind([request.blob], capabilities)
      if (unsupported) {
        throw new Error(orcadMigrationBlobKindUnsupportedBlocker(unsupported))
      }
    }
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_blob_failed:${response.error.message}`)
  }
  return parseOrcadMigrationBlobChunkResult(response.result, request)
}

export async function listServerRows(
  pairingCode: string,
  method: string,
  rows: string,
  options: CatalogRequestOptions
): Promise<unknown> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(pairing, method, undefined, options)
  if (!response.ok) {
    throw new Error(`orcad_migration_${rows}_failed:${response.error.message}`)
  }
  return response.result
}

// repo.list returns full stored rows; omitted host fields identify server-local repos.
const ServerRepositoriesSchema = z.object({
  repos: z.array(
    z.object({
      id: z.string().min(1),
      path: z.string().min(1),
      connectionId: z.string().nullish(),
      executionHostId: z.string().nullish(),
      projectGroupId: z.string().nullish()
    })
  )
})

export async function listRemoteOrcadRepositories(
  pairingCode: string,
  options: CatalogRequestOptions = {}
): Promise<OrcadServerRepository[]> {
  const result = await listServerRows(pairingCode, 'repo.list', 'repositories', options)
  return ServerRepositoriesSchema.parse(result).repos.map(
    ({ id, path, connectionId, executionHostId, projectGroupId }) => ({
      id,
      path,
      ...(connectionId != null ? { connectionId } : {}),
      ...(executionHostId != null ? { executionHostId } : {}),
      ...(projectGroupId != null ? { projectGroupId } : {})
    })
  )
}

async function requestCatalogState(
  pairingCode: string,
  operation: Exclude<OrcadCatalogMigrationOperation, 'abort'>,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions
): Promise<OrcadMigrationCatalogState> {
  const result = await request(pairingCode, operation, manifest, options)
  return parseOrcadMigrationCatalogState(result, manifest)
}

async function request(
  pairingCode: string,
  operation: OrcadCatalogMigrationOperation,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions,
  expectedBlobs: readonly OrcadMigrationBlobDescriptor[] = []
): Promise<unknown> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  // Preserve exact { manifest } wire shape for blob-free and SSH moves.
  const params = expectedBlobs.length > 0 ? { manifest, expectedBlobs } : { manifest }
  // Validation-size limits can exceed sealed-frame capacity; reject before the host closes the socket.
  assertOrcadMigrationRequestFits(params)
  const carriesExtraAgentArgs =
    (operation === 'stage' || operation === 'commit') &&
    (manifest.payload.dormantState?.automations ?? []).some((automation) =>
      hasExtraAgentArgs(automation.extraAgentArgs)
    )
  const response = await sendSupportedMigrationRequest(
    pairing,
    METHOD_BY_OPERATION[operation],
    params,
    options,
    carriesExtraAgentArgs,
    // Recheck source capabilities on every operation; older hosts may misparse non-SSH sources.
    requiredOrcadMigrationSourceCapability(manifest.source),
    // Hosts without blob capability would strip expectedBlobs and commit unchecked.
    (capabilities) => {
      const unsupported = findUnsupportedMigrationBlobKind(expectedBlobs, capabilities)
      if (unsupported) {
        throw new Error(orcadMigrationBlobKindUnsupportedBlocker(unsupported))
      }
    }
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_${operation}_failed:${response.error.message}`)
  }
  return response.result
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
  const response = await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
    pairedRuntimeConnectionFromOffer(pairing),
    method,
    params,
    options.timeoutMs ?? 15_000,
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
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
    options.signal
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
