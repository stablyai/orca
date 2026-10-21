/**
 * A fake world for the WSL move driver: a profile with one WSL project, a WSL host whose catalog,
 * blob staging and commit can fail at named points (the fault-injection pattern of #29826), and
 * terminals that pause on request. The journal is the real one, in a temp directory.
 */
import type {
  OrcadMigrationBlobDescriptor,
  OrcadMigrationBlobUploadState
} from '../../../../shared/orcad-migration/orcad-migration-blob-transfer'
import { ORCAD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../../shared/orcad-migration/orcad-migration-blob-transfer'
import type {
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../../../shared/orcad-migration/orcad-migration-manifest'
import {
  ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
  ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
} from '../../../../shared/orcad-runtime-capabilities'
import { getDefaultPersistedState } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import type { WslMoveProgressEvent } from '../../../../shared/wsl-move/wsl-move-driver-types'
import { collectOrcadMigrationSourceDormantState } from '../../migrating-orcad-catalog/orcad-source-dormant-state'
import { exportWslMoveManifest } from '../../moving-wsl-projects/wsl-move-manifest-export'
import { runWslMoveDesktopRewritePass } from '../../moving-wsl-projects/wsl-move-desktop-rewrite'
import type {
  WslMoveDriverDeps,
  WslMoveHost,
  WslMoveManifestExport
} from '../../moving-wsl-projects/wsl-move-driver-ports'
import type { WslMoveGateInputs } from '../../moving-wsl-projects/wsl-move-terminal-gate'

export class WslMoveWorldCrash extends Error {}

export const WSL_MOVE_WORLD_PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

export type WslMoveWorldState = {
  /** Where the next failure fires; each fires once. */
  failAt: Set<string>
  points: string[]
  catalog: Map<string, 'staged' | 'committed'>
  blobUploads: Map<string, OrcadMigrationBlobUploadState>
  committedWithBlobs: OrcadMigrationBlobDescriptor[] | null
  progress: WslMoveProgressEvent[]
  slept: string[][]
  gate: WslMoveGateInputs
  /** Overrides the export, e.g. to grow it after Sleep. */
  exportOverride: ((exported: WslMoveManifestExport, call: number) => WslMoveManifestExport) | null
  repos: Repo[]
}

export type WslMoveWorld = WslMoveWorldState & { deps: WslMoveDriverDeps }

const unc = (linux: string): string => `\\\\wsl.localhost\\Ubuntu${linux.replaceAll('/', '\\')}`

export function createWslMoveWorld(userDataPath: string): WslMoveWorld {
  const world: WslMoveWorldState = {
    failAt: new Set(),
    points: [],
    catalog: new Map(),
    blobUploads: new Map(),
    committedWithBlobs: null,
    progress: [],
    slept: [],
    gate: { panes: [], runningAutomationRunIds: [], activeDispatchIds: [] },
    exportOverride: null,
    repos: [
      {
        id: 'repo-1',
        path: unc('/home/dev/app'),
        displayName: 'app',
        badgeColor: '#000',
        addedAt: 0
      }
    ]
  }
  const point = (name: string): void => {
    world.points.push(name)
    if (world.failAt.delete(name)) {
      throw new WslMoveWorldCrash(name)
    }
  }
  const state = (manifest: OrcadMigrationManifest): OrcadMigrationCatalogState => {
    const ids = { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
    const held = world.catalog.get(manifest.migrationId)
    if (held === 'committed') {
      return {
        state: 'committed',
        ...ids,
        receipt: {
          version: manifest.version,
          ...ids,
          source: manifest.source,
          importedAt: '2026-10-20T00:00:00.000Z',
          repositoryIds: manifest.payload.repositories.map((repo) => repo.id),
          projectGroupIds: [],
          folderWorkspaceIds: []
        }
      }
    }
    if (held === 'staged') {
      return {
        state: 'staged',
        ...ids,
        stagedAt: '2026-10-20T00:00:00.000Z',
        blobUploads: [...world.blobUploads.values()]
      }
    }
    return { state: 'absent', ...ids }
  }
  const commit = async (manifest: OrcadMigrationManifest): Promise<OrcadMigrationCatalogState> => {
    point('commit:before')
    if (!world.catalog.has(manifest.migrationId)) {
      throw new Error('orcad_migration_catalog_not_staged')
    }
    world.catalog.set(manifest.migrationId, 'committed')
    point('commit:lost-reply')
    return state(manifest)
  }
  const host: WslMoveHost = {
    // The journal fixture's spelling, so a seeded earlier move names this same host.
    environmentId: 'wsl:Ubuntu',
    name: 'Ubuntu',
    capabilities: [
      ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY,
      ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
      ...Object.values(ORCAD_MIGRATION_BLOB_KIND_CONTRACTS).map((contract) => contract.capability)
    ],
    catalog: {
      readState: async (manifest) => state(manifest),
      stage: async (manifest) => {
        point('stage:before')
        if (!world.catalog.has(manifest.migrationId)) {
          world.catalog.set(manifest.migrationId, 'staged')
        }
        point('stage:lost-reply')
        return state(manifest)
      },
      commit,
      abort: async (manifest) => {
        const aborted = world.catalog.get(manifest.migrationId) === 'staged'
        if (aborted) {
          world.catalog.delete(manifest.migrationId)
          world.blobUploads.clear()
        }
        return { ...state(manifest), aborted, durableAbsent: true }
      },
      abortByReference: async () => {
        throw new Error('unused')
      },
      stageChunk: async () => {
        throw new Error('unused: the fixture carries no scrollback snapshots')
      }
    },
    commitWithBlobs: async (manifest, expectedBlobs) => {
      world.committedWithBlobs = [...expectedBlobs]
      return commit(manifest)
    },
    blobs: {
      stageChunk: async (request) => {
        point(`blob:${request.blob.blobKind}`)
        const bytes = Buffer.from(request.bytesBase64, 'base64').length
        const received = request.offset + bytes
        world.blobUploads.set(request.blob.key, { ...request.blob, receivedBytes: received })
        return {
          migrationId: request.migrationId,
          manifestSha256: request.manifestSha256,
          blobKind: request.blob.blobKind,
          key: request.blob.key,
          receivedBytes: received
        }
      }
    },
    readHolding: async () => ({ repoIds: [], folderWorkspaceIds: [], highestGeneration: 0 })
  }
  let exports = 0
  let migrations = 0
  const deps: WslMoveDriverDeps = {
    userDataPath,
    readCatalog: () => ({ repos: world.repos, folderWorkspaces: [], projectGroups: [] }),
    connectHost: async () => host,
    exportManifest: (request) => {
      exports += 1
      const state = getDefaultPersistedState('C:\\Users\\dev')
      state.repos = world.repos
      const exported = exportWslMoveManifest(
        {
          getRepos: () => world.repos,
          getFolderWorkspaces: () => [],
          getProjectGroups: () => [],
          inspectOrcadMigrationSourceDormantState: (source, catalog, destination) =>
            collectOrcadMigrationSourceDormantState(state, source, catalog, undefined, destination)
        },
        request
      )
      return world.exportOverride ? world.exportOverride(exported, exports) : exported
    },
    gateInputs: async () => world.gate,
    listPanes: () => [{ paneKey: WSL_MOVE_WORLD_PANE, sessionId: 'session-1', wslDistro: null }],
    quiesce: {
      sleepWorkspaces: async (ids) => {
        world.slept.push([...ids])
        return { failedWorktreeIds: [] }
      },
      livePtyIds: () => [],
      captureRestoreHints: async () => ({
        hints: [{ paneKey: WSL_MOVE_WORLD_PANE, cwd: '/home/dev/app/src' }],
        unreadablePaneKeys: [],
        noCwdPaneKeys: [],
        staleCwdPaneKeys: []
      }),
      proveExited: async () => {
        point('prove-exited')
        return { verdict: 'exited' }
      }
    },
    snapshots: {
      readOrcadMigrationSourceSnapshotChunk: () => {
        throw new Error('unused')
      }
    },
    shellHistory: async () => ({
      descriptors: [],
      source: {
        readChunk: async () => {
          throw new Error('unused')
        }
      }
    }),
    finishOnDesktop: () => runWslMoveDesktopRewritePass({ userDataPath, warn: () => {} }),
    progress: (event) => world.progress.push(event),
    newMigrationId: () => `move-${(migrations += 1)}`,
    now: () => new Date('2026-10-20T00:00:00.000Z')
  }
  return Object.assign(world, { deps })
}
