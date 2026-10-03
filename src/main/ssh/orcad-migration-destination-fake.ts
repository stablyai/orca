import { vi, type Mock } from 'vitest'
import type {
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import type { OrcadMigrationDestinationCatalog } from './orcad-migration-cutover-coordinator'

type Catalog = OrcadMigrationDestinationCatalog

export type FakeOrcadMigrationDestination = { commits: number } & {
  [Method in keyof Catalog]: Mock<Catalog[Method]>
}

/**
 * An in-memory destination with the T6-9 semantics: idempotent stage, receipt-keyed commit, one
 * catalog state per migration so a delta move after a first migration starts absent.
 */
export function fakeOrcadMigrationDestination(): FakeOrcadMigrationDestination {
  const states = new Map<string, 'absent' | 'staged' | 'committed'>()
  const stateOf = (manifest: OrcadMigrationManifest) => states.get(manifest.migrationId) ?? 'absent'
  const view = (manifest: OrcadMigrationManifest): OrcadMigrationCatalogState => {
    const state = stateOf(manifest)
    const base = { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
    if (state === 'committed') {
      return {
        ...base,
        state,
        receipt: {
          version: 1,
          migrationId: manifest.migrationId,
          manifestSha256: manifest.manifestSha256,
          source: manifest.source,
          importedAt: '2026-10-01T00:00:00.000Z',
          repositoryIds: [],
          projectGroupIds: [],
          folderWorkspaceIds: []
        }
      }
    }
    return state === 'staged'
      ? { ...base, state, stagedAt: '2026-10-01T00:00:00.000Z', snapshotUploads: [] }
      : { ...base, state }
  }
  const destination: FakeOrcadMigrationDestination = {
    commits: 0,
    readState: vi.fn<Catalog['readState']>(async (manifest: OrcadMigrationManifest) =>
      view(manifest)
    ),
    stage: vi.fn<Catalog['stage']>(async (manifest: OrcadMigrationManifest) => {
      if (stateOf(manifest) === 'absent') {
        states.set(manifest.migrationId, 'staged')
      }
      return view(manifest)
    }),
    commit: vi.fn<Catalog['commit']>(async (manifest: OrcadMigrationManifest) => {
      if (stateOf(manifest) === 'staged') {
        states.set(manifest.migrationId, 'committed')
        destination.commits += 1
      }
      return view(manifest)
    }),
    abort: vi.fn<Catalog['abort']>(async (manifest: OrcadMigrationManifest) => {
      const aborted = stateOf(manifest) === 'staged'
      if (aborted) {
        states.set(manifest.migrationId, 'absent')
      }
      return { ...view(manifest), aborted, ...(aborted ? {} : { durableAbsent: true as const }) }
    }),
    stageChunk: vi.fn<Catalog['stageChunk']>()
  }
  return destination
}
