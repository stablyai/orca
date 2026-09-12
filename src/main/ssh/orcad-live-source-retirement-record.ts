import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { buildOrcadLiveSourceRetirementCandidate } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-candidate'
import {
  collectOrcadLiveRetirementProfileChanges,
  parseOrcadLiveRetirementProfileChanges
} from '../persistence/migrating-orcad-catalog/orcad-live-retirement-profile-changes'
import { parseOrcadLiveSourceReleaseIntent } from './orcad-live-source-release-intent'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'

function digest(value: unknown) {
  return createHash('sha256').update(serializeOrcadMigrationValue(value)).digest('hex')
}

export function parseOrcadLiveSourceRetirementRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('orcad_live_source_retirement_record_invalid')
  }
  const record = value as Record<string, unknown>
  const release = parseOrcadLiveSourceReleaseIntent(record.release)
  const changes = parseOrcadLiveRetirementProfileChanges(record.changes)
  const payload = { version: 1 as const, identity: release.identity, release, changes }
  if (
    record.version !== 1 ||
    !samePtyOwnershipTransferIdentity(
      parsePtyOwnershipTransferWireIdentity(record.identity),
      release.identity
    ) ||
    record.sha256 !== digest(payload)
  ) {
    throw new Error('orcad_live_source_retirement_record_binding_invalid')
  }
  return { ...payload, sha256: record.sha256 as string }
}

/** Caller supplies authenticated release observations under source lifecycle authority. */
export function createOrcadLiveSourceRetirementRecord(
  options: Omit<Parameters<typeof buildOrcadLiveSourceRetirementCandidate>[0], 'cutover'> & {
    release: unknown
  }
) {
  const release = parseOrcadLiveSourceReleaseIntent(options.release)
  const candidate = buildOrcadLiveSourceRetirementCandidate({
    ...options,
    cutover: release.cutover
  })
  const changes = collectOrcadLiveRetirementProfileChanges(options.state, candidate)
  const payload = { version: 1 as const, identity: release.identity, release, changes }
  return parseOrcadLiveSourceRetirementRecord({ ...payload, sha256: digest(payload) })
}

/** Prepared recovery evidence only; neither readable bytes nor this record prove profile installation. */
export class OrcadLiveSourceRetirementRecordStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseOrcadLiveSourceRetirementRecord>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-live-source-retirement-records'),
      parseOrcadLiveSourceRetirementRecord,
      'orcad_live_source_retirement_record'
    )
  }
}
