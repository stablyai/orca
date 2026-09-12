import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { groupOrcadLiveCatalogAdmissions } from './orcad-live-catalog-admissions'
import { createOutgoingOrcadCatalogPreparationUnderAuthority } from './orcad-outgoing-preparation-creation'
import { prepareOutgoingOrcadTerminalUnderAuthority } from './orcad-outgoing-terminal-preparation'
import { recordOrcadLiveCutoverProgressDurably } from './orcad-live-cutover-progress'
import { assertOrcadLiveCutoverCurrent } from './orcad-live-cutover-current'
import type { stageOrcadLiveDestination } from './orcad-live-destination-staging'

/** Caller holds lifecycle locks; each publication is durable before preparing the next terminal. */
export async function publishOrcadLiveTerminals(
  options: Omit<Parameters<typeof stageOrcadLiveDestination>[0], 'remote'> & {
    runtime: Parameters<typeof prepareOutgoingOrcadTerminalUnderAuthority>[1]['runtime']
  }
) {
  let cutover = parseOrcadMigrationSourceCutover(options.cutover)
  if (cutover.version !== 2 || cutover.phase !== 'destination-staged') {
    throw new Error('orcad_live_cutover_phase_observation_required')
  }
  const assertCurrent = () => assertOrcadLiveCutoverCurrent({ ...options, cutover })
  assertCurrent()
  const admissions = groupOrcadLiveCatalogAdmissions(cutover)
  for (const catalogAdmission of admissions) {
    for (const { identity, surfaceBinding } of catalogAdmission.bindings) {
      assertCurrent()
      const ptyId = toAppSshPtyId(cutover.manifest.source.sshTargetId, identity.terminalId)
      const preparation = await createOutgoingOrcadCatalogPreparationUnderAuthority(
        options.profileDirectory,
        {
          binding: {
            version: 2,
            identity,
            destinationEnvironmentId: cutover.destinationEnvironmentId,
            sourceSshTargetId: cutover.manifest.source.sshTargetId,
            sourceSshTargetGeneration: cutover.manifest.source.sshTargetGeneration,
            catalogAdmission
          },
          ptyId,
          surfaceBinding,
          signal: options.signal,
          assertAuthority: assertCurrent
        }
      )
      assertCurrent()
      const result = await prepareOutgoingOrcadTerminalUnderAuthority(
        options.profileDirectory,
        {
          preparation,
          ptyId,
          runtime: options.runtime,
          signal: options.signal,
          requireSavedPreparation: true
        },
        { pairingCode: options.pairingCode, assertAuthority: assertCurrent }
      )
      assertCurrent()
      // The captured-destination client authenticates identity, surface and catalog before returning.
      const publication = {
        identity: result.identity,
        publicationReceipt: result.publicationReceipt,
        catalog: {
          migrationId: cutover.manifest.migrationId,
          manifestSha256: cutover.manifest.manifestSha256
        }
      }
      const publications = [...(cutover.terminalPublications ?? [])]
      const index = publications.findIndex((entry) => entry.identity.bridgeId === identity.bridgeId)
      if (index === -1) {
        publications.push(publication)
      } else {
        publications[index] = publication
      }
      cutover = await recordOrcadLiveCutoverProgressDurably({
        ...options,
        migrationId: cutover.manifest.migrationId,
        next: { ...cutover, terminalPublications: publications },
        assertAuthority: options.assertAuthority
      })
      assertCurrent()
    }
  }
  return cutover
}
