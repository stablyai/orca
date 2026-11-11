import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../../../shared/orcad-migration/orcad-migration-manifest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../../shared/wsl-host-internal-gate'
import type { WslMoveCutoverPhase } from '../../../../shared/wsl-move/wsl-move-cutover'
import type { OrcadMigrationDestinationCatalog } from '../../../managed-server/migration/cutover/orcad-migration-cutover-coordinator'

import { orcadMigrationRequestFits } from '../../../managed-server/migration/catalog/orcad-migration-request-budget'

import { wslMoveCutoverFixture } from '../../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../__fixtures__/wsl-mover/wsl-move-journal-seeding'

import { resolveWslMoveFence } from '../quiescence/wsl-move-fence'
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
})
