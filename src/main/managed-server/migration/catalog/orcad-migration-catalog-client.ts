import { hasModernAutomationLaunchSetup } from '../../../../shared/automations/launch/automation-launch-setup'
import { automationCanonicalLaunchSetup } from '../../../../shared/automations/launch/automation-canonical-launch-setup'
import { AUTOMATION_LAUNCH_SETUP_RUNTIME_CAPABILITY } from '../../../../shared/automations/automation-runtime-capabilities'
import {
  parseOrcadMigrationCatalogAbortResult,
  parseOrcadMigrationCatalogState
} from '../../../../shared/orcad-migration/orcad-migration-catalog-state'

import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../../../shared/orcad-migration/orcad-migration-manifest'

import {
  findUnsupportedMigrationBlobKind,
  orcadMigrationBlobKindUnsupportedBlocker
} from '../../../../shared/orcad-migration/orcad-migration-blob-transfer'

import type { OrcadMigrationBlobDescriptor } from '../../../../shared/orcad-migration/orcad-migration-blob-transfer'
import { orcadMigrationManifestBlobs } from '../../../../shared/orcad-migration/orcad-migration-automation-run-history'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import { assertOrcadMigrationRequestFits } from './orcad-migration-request-budget'
import { hasExtraAgentArgs } from '../../../../shared/agent-launch/startup/automation-extra-agent-args'
import { requiredOrcadMigrationSourceCapability } from '../../../../shared/orcad-migration/orcad-migration-source-kind'
import type { CatalogRequestOptions } from './orcad-migration-request'
import { sendSupportedMigrationRequest } from './orcad-migration-request'

type OrcadCatalogMigrationOperation = 'abort' | 'commit' | 'stage' | 'state'

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
  const imports = operation === 'stage' || operation === 'commit'
  const carriesExtraAgentArgs =
    imports &&
    (manifest.payload.dormantState?.automations ?? []).some((automation) =>
      hasExtraAgentArgs(automation.extraAgentArgs)
    )
  // An older host would drop the blob a manifest names and import without its rows.
  const requiredBlobs = imports
    ? [...expectedBlobs, ...orcadMigrationManifestBlobs(manifest)]
    : expectedBlobs
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
      if (
        imports &&
        (manifest.payload.dormantState?.automations ?? []).some((automation) =>
          hasModernAutomationLaunchSetup(automationCanonicalLaunchSetup(automation))
        ) &&
        !capabilities.includes(AUTOMATION_LAUNCH_SETUP_RUNTIME_CAPABILITY)
      ) {
        throw new Error(
          'Update Orca on the destination host to keep automation agent launch settings.'
        )
      }
      const unsupported = findUnsupportedMigrationBlobKind(requiredBlobs, capabilities)
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
