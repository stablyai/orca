import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../../shared/orcad-migration/orcad-migration-manifest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import type { WslMoveCutoverPhase } from '../../../shared/wsl-move/wsl-move-cutover'
import type { OrcadMigrationDestinationCatalog } from '../../managed-server/migration/cutover/orcad-migration-cutover-coordinator'
import { MAX_ORCAD_MIGRATION_MANIFEST_BYTES } from '../../../shared/orcad-migration/orcad-migration-manifest-validation'
import {
  ORCAD_MIGRATION_REQUEST_PARAMS_BUDGET_BYTES,
  orcadMigrationRequestFits
} from '../../managed-server/migration/catalog/orcad-migration-request-budget'
import { computeOrcadMigrationManifestSha256 } from '../../orcad/orcad-migration-manifest-digest'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers, wslMoveJournalDirectory } from './wsl-move-cutover-journal'
import { resolveWslMoveFence } from './wsl-move-fence'
import { resetWslMoveToZero } from './wsl-move-reset'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-reset-'))
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(userDataPath, { recursive: true, force: true })
})

function seed(phase: WslMoveCutoverPhase, migrationId = 'move-1'): void {
  seedWslMoveCutover(userDataPath, wslMoveCutoverFixture(migrationId, phase))
}

function state(
  kind: 'absent' | 'staged' | 'committed',
  manifest: OrcadMigrationManifest
): OrcadMigrationCatalogState {
  const ids = { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
  if (kind === 'absent') {
    return { state: 'absent', ...ids }
  }
  if (kind === 'staged') {
    return { state: 'staged', ...ids, stagedAt: '2026-10-16T00:00:00.000Z' }
  }
  return {
    state: 'committed',
    ...ids,
    receipt: {
      version: manifest.version,
      ...ids,
      source: manifest.source,
      importedAt: '2026-10-16T00:00:00.000Z',
      repositoryIds: [],
      projectGroupIds: [],
      folderWorkspaceIds: []
    }
  }
}

function host(
  catalog: { current: 'absent' | 'staged' | 'committed' },
  options: { refuseInline?: boolean; durableCommitted?: boolean } = {}
): {
  destination: OrcadMigrationDestinationCatalog
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    destination: {
      readState: async (manifest) => {
        assertCarried(manifest, options.refuseInline)
        calls.push('read')
        return state(catalog.current, manifest)
      },
      stage: async () => {
        throw new Error('not used')
      },
      commit: async (manifest) => {
        calls.push('commit')
        return state(catalog.current, manifest)
      },
      abort: async (manifest): Promise<OrcadMigrationCatalogAbortResult> => {
        assertCarried(manifest, options.refuseInline)
        calls.push('abort')
        const aborted = catalog.current === 'staged'
        if (aborted) {
          catalog.current = 'absent'
        }
        return { ...state(catalog.current, manifest), aborted }
      },
      abortByReference: async (manifest) => {
        calls.push('abort-by-reference')
        const aborted = catalog.current === 'staged'
        if (aborted) {
          catalog.current = 'absent'
        }
        const ids = { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
        if (catalog.current === 'committed') {
          // An older host omits the flag: its committed answer may not be flushed yet.
          return options.durableCommitted === false
            ? { ...ids, state: 'committed', aborted: false }
            : { ...ids, state: 'committed', aborted: false, durableCommitted: true }
        }
        return { ...ids, state: 'absent', aborted, durableAbsent: true }
      },
      stageChunk: async () => {
        throw new Error('not used')
      },
      readCapabilities: async () => [],
      stageBlobChunk: async () => {
        throw new Error('not used')
      }
    }
  }
}

/** A real host closes the socket on a request this large; the fake refuses it the same way. */
function assertCarried(manifest: OrcadMigrationManifest, refuse = false): void {
  if (refuse || !orcadMigrationRequestFits({ manifest })) {
    throw new Error('socket closed: request too large')
  }
}

/**
 * The widest gap the validators allow: under the manifest cap, so the journal still reads it, yet
 * over what one request can carry. New moves are refused this size; older records may hold it.
 */
function seedOversized(phase: WslMoveCutoverPhase): void {
  const base = wslMoveCutoverFixture('move-1', phase)
  const sized = (padding: number) => {
    const { manifestSha256: _digest, ...unsigned } = base.manifest
    const payload = {
      ...unsigned.payload,
      repositories: unsigned.payload.repositories.map((repo) => ({
        ...repo,
        displayName: 'x'.repeat(padding)
      }))
    }
    const signed = { ...unsigned, payload }
    return { ...signed, manifestSha256: computeOrcadMigrationManifestSha256(signed) }
  }
  const overhead = JSON.stringify(sized(0)).length
  const manifest = sized(MAX_ORCAD_MIGRATION_MANIFEST_BYTES - overhead - 16)
  expect(JSON.stringify(manifest).length).toBeLessThanOrEqual(MAX_ORCAD_MIGRATION_MANIFEST_BYTES)
  expect(JSON.stringify({ manifest }).length).toBeGreaterThan(
    ORCAD_MIGRATION_REQUEST_PARAMS_BUDGET_BYTES
  )
  // Written past the journal's size cap on purpose: a record from before the cap must still reset.
  seedWslMoveCutover(userDataPath, base)
  writeFileSync(
    join(wslMoveJournalDirectory(userDataPath), `${base.migrationId}.json`),
    JSON.stringify({
      ...base,
      manifestSha256: manifest.manifestSha256,
      manifest: { ...manifest, source: base.manifest.source }
    })
  )
}

const fenced = (): boolean => resolveWslMoveFence(userDataPath).fenced.repoIds.has('repo-1')

describe('resetWslMoveToZero', () => {
  it('keeps a move that may have committed fenced until the host answers', async () => {
    seed('blobs-transferred')
    expect(await resetWslMoveToZero({ userDataPath, destination: null }, 'move-1')).toEqual({
      outcome: 'unverifiable',
      reason: 'destination_unreachable'
    })
    expect(fenced()).toBe(true)
  })

  it('keeps the fence when the host reports a commit no request could have made', async () => {
    seed('destination-staged')
    const { destination } = host({ current: 'committed' })
    expect(await resetWslMoveToZero({ userDataPath, destination }, 'move-1')).toEqual({
      outcome: 'unverifiable',
      reason: 'committed_without_commit_request'
    })
    expect(fenced()).toBe(true)
  })

  it('never moves forward on a committed answer the host did not flush first', async () => {
    seedOversized('blobs-transferred')
    const { destination } = host({ current: 'committed' }, { durableCommitted: false })
    expect(await resetWslMoveToZero({ userDataPath, destination }, 'move-1')).toEqual({
      outcome: 'unverifiable',
      reason: 'commit_not_proven_durable'
    })
    expect(fenced()).toBe(true)
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('blobs-transferred')
  })
})
