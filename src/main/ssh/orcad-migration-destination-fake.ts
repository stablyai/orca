import { vi, type Mock } from 'vitest'
import type {
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'
import { parseOrcadMigrationManifest } from '../../shared/orcad-migration/orcad-migration-manifest-validation'
import { advertisedOrcadMigrationDestinationCapabilities } from '../orcad/orcad-migration-destination-capabilities'
import { assertOrcadMigrationManifestDigest } from '../orcad/orcad-migration-manifest-digest'
import type { Store } from '../persistence/loading-store/store'
import type { OrcadMigrationDestinationCatalog } from './orcad-migration-cutover-coordinator'

type Catalog = OrcadMigrationDestinationCatalog

export type FakeOrcadMigrationDestination = { commits: number } & {
  [Method in keyof Catalog]: Mock<Catalog[Method]>
}

/** Model idempotent stage and receipt-keyed commit with separate catalog state for each migration, including later deltas. */
export function fakeOrcadMigrationDestination(): FakeOrcadMigrationDestination {
  const states = new Map<string, 'absent' | 'staged' | 'committed'>()
  const stateOf = (manifest: Pick<OrcadMigrationManifest, 'migrationId'>) =>
    states.get(manifest.migrationId) ?? 'absent'
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
    abortByReference: vi.fn<Catalog['abortByReference']>(async (manifest) => {
      const identity = {
        migrationId: manifest.migrationId,
        manifestSha256: manifest.manifestSha256
      }
      if (stateOf(manifest) === 'committed') {
        return { ...identity, state: 'committed', aborted: false }
      }
      const aborted = stateOf(manifest) === 'staged'
      states.delete(manifest.migrationId)
      return { ...identity, state: 'absent', aborted, durableAbsent: true }
    }),
    stageChunk: vi.fn<Catalog['stageChunk']>(),
    readCapabilities: vi.fn<Catalog['readCapabilities']>(async () => []),
    stageBlobChunk: vi.fn<Catalog['stageBlobChunk']>()
  }
  return destination
}

/** A host server's real import, behind manifests sent as the RPC handler receives them. */
export function storeBackedOrcadMigrationDestination(server: Store): Catalog {
  const sent = (manifest: OrcadMigrationManifest): OrcadMigrationManifest => {
    const raw = JSON.parse(JSON.stringify(manifest))
    assertOrcadMigrationManifestDigest(raw)
    return parseOrcadMigrationManifest(raw)
  }
  return {
    readState: async (manifest) => server.getOrcadMigrationCatalogState(sent(manifest)),
    stage: async (manifest) => server.stageOrcadMigrationCatalog(sent(manifest)),
    commit: async (manifest) => server.commitStagedOrcadMigrationCatalog(sent(manifest)),
    abort: async (manifest) => {
      const result = server.abortStagedOrcadMigrationCatalog(sent(manifest))
      return result.aborted ? result : { ...result, durableAbsent: true as const }
    },
    abortByReference: async (reference) =>
      server.abortStagedOrcadMigrationCatalogByReference(reference),
    stageChunk: async (request) => server.stageOrcadMigrationSnapshotChunk(request),
    readCapabilities: async () => advertisedOrcadMigrationDestinationCapabilities(),
    stageBlobChunk: async (request) => server.stageOrcadMigrationBlobChunk(request)
  }
}
