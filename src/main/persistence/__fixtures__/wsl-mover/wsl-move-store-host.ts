/**
 * A WSL host for the move driver backed by a real orcad profile store, so staging claims, blob
 * staging, the commit's blob check and receipts are the production code. Every mutation passes a
 * kill point before it lands and after it is durable (a lost reply). A kill stops the whole desktop
 * process: from then on every call throws, so no catch handler can tidy up what a crash would leave.
 */
import type {
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../../../shared/orcad-migration/orcad-migration-manifest'
import { ORCAD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../../shared/orcad-migration/orcad-migration-blob-transfer'
import {
  ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
  ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
} from '../../../../shared/orcad-runtime-capabilities'
import type { Store } from '../../loading-store/store'
import type { WslMoveHost } from '../../moving-wsl-projects/wsl-move-driver-ports'

export class WslMoveKilled extends Error {}

export type WslMoveKillSwitch = {
  /** The point the next kill fires at; null runs clean. */
  killAt: string | null
  /** True from the kill until the test restarts the process. */
  dead: boolean
  points: string[]
  /** Runs at each point before the kill check: something else happening mid-move. */
  onPoint?: (name: string) => void
}

export function createWslMoveKillSwitch(): WslMoveKillSwitch {
  return { killAt: null, dead: false, points: [] }
}

export function passWslMoveKillPoint(kill: WslMoveKillSwitch, name: string): void {
  if (kill.dead) {
    throw new WslMoveKilled(`dead at ${name}`)
  }
  kill.points.push(name)
  kill.onPoint?.(name)
  if (kill.killAt === name) {
    kill.killAt = null
    kill.dead = true
    throw new WslMoveKilled(name)
  }
}

/** Every capability a current WSL host advertises for a move. */
export const WSL_MOVE_STORE_HOST_CAPABILITIES: readonly string[] = [
  ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY,
  ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
  ...Object.values(ORCAD_MIGRATION_BLOB_KIND_CONTRACTS).map((contract) => contract.capability)
]

export type WslMoveStoreHostOptions = {
  /** The host's current store; an orcad restart swaps it for one reopened from disk. */
  store: () => Store
  kill: WslMoveKillSwitch
  /** Points named `<prefix>stage:before` etc., so two desktops on one host stay apart. */
  prefix?: string
  environmentId?: string
  name?: string
  /** False once the distro is unregistered: every call fails like a vanished host. */
  available?: () => boolean
}

export function createWslMoveStoreHost(options: WslMoveStoreHostOptions): WslMoveHost {
  const { store, kill } = options
  const prefix = options.prefix ?? ''
  const at = (name: string): void => {
    passWslMoveKillPoint(kill, `${prefix}${name}`)
    if (options.available && !options.available()) {
      throw new Error('wsl_distro_not_registered')
    }
  }
  // Like the RPC layer: a mutation answers only once it is on disk.
  const mutate = async <T>(name: string, apply: () => T): Promise<T> => {
    at(`${name}:before`)
    const result = apply()
    await store().flushPendingOrThrowAsync()
    at(`${name}:lost-reply`)
    return result
  }
  const read = (manifest: OrcadMigrationManifest): OrcadMigrationCatalogState => {
    at('read-state')
    return store().getOrcadMigrationCatalogState(manifest)
  }
  return {
    environmentId: options.environmentId ?? 'wsl:Ubuntu',
    name: options.name ?? 'Ubuntu',
    capabilities: WSL_MOVE_STORE_HOST_CAPABILITIES,
    catalog: {
      readState: async (manifest) => read(manifest),
      stage: (manifest) => mutate('stage', () => store().stageOrcadMigrationCatalog(manifest)),
      commit: (manifest) =>
        mutate('commit', () => store().commitStagedOrcadMigrationCatalog(manifest)),
      abort: async (manifest) => ({
        ...(await mutate('abort', () => store().abortStagedOrcadMigrationCatalog(manifest))),
        durableAbsent: true
      }),
      abortByReference: (manifest) =>
        mutate('abort-by-reference', () =>
          store().abortStagedOrcadMigrationCatalogByReference({
            migrationId: manifest.migrationId,
            manifestSha256: manifest.manifestSha256
          })
        ),
      stageChunk: (request) =>
        mutate('snapshot-chunk', () => store().stageOrcadMigrationSnapshotChunk(request))
    },
    commitWithBlobs: (manifest, expectedBlobs) =>
      mutate('commit', () =>
        store().commitStagedOrcadMigrationCatalog(manifest, { expectedBlobs })
      ),
    blobs: {
      stageChunk: (request) =>
        mutate(`blob:${request.blob.blobKind}`, () => store().stageOrcadMigrationBlobChunk(request))
    },
    readHolding: async () => {
      at('read-holding')
      return {
        repoIds: store()
          .getRepos()
          .map((repo) => repo.id),
        folderWorkspaceIds: store()
          .getFolderWorkspaces()
          .map((folder) => folder.id),
        highestGeneration: 0
      }
    }
  }
}
