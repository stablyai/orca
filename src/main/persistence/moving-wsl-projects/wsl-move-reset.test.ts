import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import type { WslMoveCutoverPhase } from '../../../shared/wsl-move/wsl-move-cutover'
import type { OrcadMigrationDestinationCatalog } from '../../ssh/orcad-migration-cutover-coordinator'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import { resolveWslMoveFence } from './wsl-move-fence'
import {
  assertWslMoveCommitRequestAllowed,
  recoverInterruptedWslMoves,
  resetWslMoveToZero
} from './wsl-move-reset'

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

function host(catalog: { current: 'absent' | 'staged' | 'committed' }): {
  destination: OrcadMigrationDestinationCatalog
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    destination: {
      readState: async (manifest) => {
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
        calls.push('abort')
        const aborted = catalog.current === 'staged'
        if (aborted) {
          catalog.current = 'absent'
        }
        return { ...state(catalog.current, manifest), aborted }
      },
      stageChunk: async () => {
        throw new Error('not used')
      }
    }
  }
}

const fenced = (): boolean => resolveWslMoveFence(userDataPath).fenced.repoIds.has('repo-1')

describe('resetWslMoveToZero', () => {
  it('lifts a move that never left the source, with no host to ask', async () => {
    seed('source-fenced')
    expect(fenced()).toBe(true)
    expect(await resetWslMoveToZero({ userDataPath, destination: null }, 'move-1')).toEqual({
      outcome: 'reset',
      evidence: 'commit-never-requested'
    })
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
    expect(fenced()).toBe(false)
  })

  it('resets a staged move without the host: no commit can have been requested', async () => {
    seed('destination-staged')
    expect(resolveWslMoveFence(userDataPath).sessionFrozen.repoIds.has('repo-1')).toBe(true)
    expect(await resetWslMoveToZero({ userDataPath, destination: null }, 'move-1')).toMatchObject({
      outcome: 'reset'
    })
    expect(resolveWslMoveFence(userDataPath).sessionFrozen.repoIds.size).toBe(0)
  })

  it('keeps a move that may have committed fenced until the host answers', async () => {
    seed('blobs-transferred')
    expect(await resetWslMoveToZero({ userDataPath, destination: null }, 'move-1')).toEqual({
      outcome: 'unverifiable',
      reason: 'destination_unreachable'
    })
    expect(fenced()).toBe(true)
  })

  it('aborts the host staging, then resets', async () => {
    seed('blobs-transferred')
    const { destination, calls } = host({ current: 'staged' })
    expect(await resetWslMoveToZero({ userDataPath, destination }, 'move-1')).toEqual({
      outcome: 'reset',
      evidence: 'catalog-absent'
    })
    expect(calls).toEqual(['read', 'abort'])
    expect(fenced()).toBe(false)
  })

  it('moves forward when the host committed, recording only an acknowledged commit', async () => {
    seed('blobs-transferred')
    const { destination, calls } = host({ current: 'committed' })
    const result = await resetWslMoveToZero({ userDataPath, destination }, 'move-1')
    expect(result.outcome).toBe('committed')
    expect(calls).toEqual(['read', 'commit'])
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('destination-committed')
    expect(resolveWslMoveFence(userDataPath).hidden.repoIds.has('repo-1')).toBe(true)
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

  it('leaves a committed move to the rewrite pass', async () => {
    seed('destination-committed')
    expect((await resetWslMoveToZero({ userDataPath, destination: null }, 'move-1')).outcome).toBe(
      'committed'
    )
    expect(listWslMoveCutovers(userDataPath)).toHaveLength(1)
  })
})

describe('assertWslMoveCommitRequestAllowed', () => {
  it('allows a commit request only from blobs-transferred', () => {
    for (const phase of ['quiesced', 'destination-staged', 'destination-committed'] as const) {
      expect(() => assertWslMoveCommitRequestAllowed({ phase })).toThrow(
        'wsl_move_commit_before_blobs_transferred'
      )
    }
    expect(() => assertWslMoveCommitRequestAllowed({ phase: 'blobs-transferred' })).not.toThrow()
  })
})

describe('recoverInterruptedWslMoves', () => {
  it('resets a move interrupted before any commit request, at startup', async () => {
    seed('quiesced')
    expect(await recoverInterruptedWslMoves(userDataPath, () => {})).toEqual({
      reset: ['move-1'],
      waitingForHost: []
    })
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })

  it('keeps a move that may have committed waiting for its host, at startup', async () => {
    seed('blobs-transferred')
    expect(await recoverInterruptedWslMoves(userDataPath, () => {})).toEqual({
      reset: [],
      waitingForHost: ['move-1']
    })
    expect(fenced()).toBe(true)
  })

  it('does nothing with the WSL hosts gate closed', async () => {
    seed('quiesced')
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    expect(await recoverInterruptedWslMoves(userDataPath, () => {})).toEqual({
      reset: [],
      waitingForHost: []
    })
    expect(listWslMoveCutovers(userDataPath)).toHaveLength(1)
  })
})
