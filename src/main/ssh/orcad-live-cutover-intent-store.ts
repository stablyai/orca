import { join } from 'node:path'
import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { assertOrcadMigrationManifestDigest } from '../orcad/orcad-migration-manifest-digest'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'

export function parseOrcadLiveCutoverIntent(value: unknown) {
  const cutover = parseOrcadMigrationSourceCutover(value)
  if (
    cutover.version !== 2 ||
    cutover.phase !== 'source-fenced' ||
    !cutover.liveTerminalBindings ||
    cutover.terminalPublications !== undefined
  ) {
    throw new Error('orcad_live_cutover_intent_invalid')
  }
  assertOrcadMigrationManifestDigest(cutover.manifest)
  const identity = cutover.liveTerminalBindings[0].identity
  const supplied = (value as Record<string, unknown>).identity
  const participationRequired = (value as Record<string, unknown>).profileParticipationRequired
  if (participationRequired !== undefined && participationRequired !== true) {
    throw new Error('orcad_live_cutover_participation_marker_invalid')
  }
  if (
    supplied !== undefined &&
    !samePtyOwnershipTransferIdentity(parsePtyOwnershipTransferWireIdentity(supplied), identity)
  ) {
    throw new Error('orcad_live_cutover_intent_identity_mismatch')
  }
  return {
    ...cutover,
    version: 2 as const,
    phase: 'source-fenced' as const,
    identity,
    ...(participationRequired === true ? { profileParticipationRequired: true as const } : {})
  }
}

/** Retained initial authority, not phase evidence; persist before writing the source owner fence. */
export class OrcadLiveCutoverIntentStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseOrcadLiveCutoverIntent>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-live-cutover-intents'),
      parseOrcadLiveCutoverIntent,
      'orcad_live_cutover_intent'
    )
  }

  override persist(value: unknown) {
    const record = parseOrcadLiveCutoverIntent(value)
    for (const existing of this.list()) {
      if (
        (existing.manifest.migrationId === record.manifest.migrationId ||
          existing.manifest.source.sshTargetId === record.manifest.source.sshTargetId) &&
        !samePtyOwnershipTransferIdentity(existing.identity, record.identity)
      ) {
        throw new Error('orcad_live_cutover_intent_conflict')
      }
    }
    return super.persist(record)
  }
}
