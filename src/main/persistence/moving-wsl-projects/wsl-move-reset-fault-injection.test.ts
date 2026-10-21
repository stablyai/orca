/**
 * Fault injection across a whole WSL move: a crash at every phase boundary, inside every
 * destination call (before or after it lands), and inside every desktop rewrite store. After the
 * restart recovery, each run must end back at zero or fully moved; nothing in between survives.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../../shared/orcad-migration/orcad-migration-manifest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import type { WslMoveCutover, WslMoveCutoverPhase } from '../../../shared/wsl-move/wsl-move-cutover'
import type { OrcadMigrationDestinationCatalog } from '../../ssh/orcad-migration-cutover-coordinator'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { listWslMoveCutovers, writeWslMoveCutover } from './wsl-move-cutover-journal'
import { runWslMoveDesktopRewritePass } from './wsl-move-desktop-rewrite'
import {
  registerWslMoveDesktopRewriteStore,
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests
} from './wsl-move-desktop-rewrite-stores'
import { resolveWslMoveFence } from './wsl-move-fence'
import {
  assertWslMoveCommitRequestAllowed,
  recoverInterruptedWslMoves,
  resetWslMoveToZero
} from './wsl-move-reset'

class Crash extends Error {}

const STORE_IDS = ['repos', 'sessions', 'ui'] as const

type World = {
  userDataPath: string
  /** Where the next crash fires; null runs clean. */
  crashAt: string | null
  /** Points passed this run, in order. */
  points: string[]
  /** The host's catalog state, per migration id. */
  catalog: Map<string, 'staged' | 'committed'>
  /** False once the host can no longer take this manifest inline (a lowered request limit). */
  carriesManifest: boolean
  /** Store id → how many times its rewrite took effect (idempotent: stays 0 or 1). */
  rewritten: Map<string, number>
}

function point(world: World, name: string): void {
  world.points.push(name)
  if (world.crashAt === name) {
    world.crashAt = null
    throw new Crash(name)
  }
}

function catalogState(world: World, manifest: OrcadMigrationManifest): OrcadMigrationCatalogState {
  const ids = { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
  const state = world.catalog.get(manifest.migrationId)
  if (state === 'committed') {
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
  if (state === 'staged') {
    return { state: 'staged', ...ids, stagedAt: '2026-10-16T00:00:00.000Z' }
  }
  return { state: 'absent', ...ids }
}

/** Each mutation can crash before it lands, or land and lose its reply. */
function destination(world: World): OrcadMigrationDestinationCatalog {
  const mutate = (
    name: string,
    manifest: OrcadMigrationManifest,
    apply: () => void
  ): OrcadMigrationCatalogState => {
    point(world, `${name}:before`)
    apply()
    point(world, `${name}:lost-reply`)
    return catalogState(world, manifest)
  }
  const carried = (manifest: OrcadMigrationManifest): OrcadMigrationManifest => {
    if (!world.carriesManifest) {
      throw new Error('socket closed: request too large')
    }
    return manifest
  }
  return {
    readState: async (manifest) => catalogState(world, carried(manifest)),
    stage: async (manifest) =>
      mutate('stage', carried(manifest), () => {
        if (!world.catalog.has(manifest.migrationId)) {
          world.catalog.set(manifest.migrationId, 'staged')
        }
      }),
    commit: async (manifest) =>
      mutate('commit', carried(manifest), () => {
        if (!world.catalog.has(manifest.migrationId)) {
          throw new Error('orcad_migration_catalog_not_staged')
        }
        world.catalog.set(manifest.migrationId, 'committed')
      }),
    abort: async (manifest): Promise<OrcadMigrationCatalogAbortResult> => {
      carried(manifest)
      const aborted = world.catalog.get(manifest.migrationId) === 'staged'
      if (aborted) {
        world.catalog.delete(manifest.migrationId)
      }
      return { ...catalogState(world, manifest), aborted }
    },
    abortByReference: async (manifest) => {
      const ids = { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
      const held = world.catalog.get(manifest.migrationId)
      // Both answers flushed first, as the host does before replying by reference.
      if (held === 'committed') {
        return { ...ids, state: 'committed', aborted: false, durableCommitted: true }
      }
      world.catalog.delete(manifest.migrationId)
      return { ...ids, state: 'absent', aborted: held === 'staged', durableAbsent: true }
    },
    stageChunk: async () => {
      throw new Error('unused: blob transfer is a crash point in runMove')
    }
  }
}

function registerStores(world: World): void {
  for (const id of STORE_IDS) {
    registerWslMoveDesktopRewriteStore({
      id,
      side: 'main',
      run: () => {
        point(world, `store:${id}:run`)
        world.rewritten.set(id, 1)
      },
      flush: () => point(world, `store:${id}:flush`)
    })
  }
}

function advance(
  world: World,
  cutover: WslMoveCutover,
  phase: WslMoveCutoverPhase
): WslMoveCutover {
  point(world, `journal:${phase}:before`)
  const next = { ...cutover, phase, updatedAt: new Date().toISOString() }
  writeWslMoveCutover(world.userDataPath, next)
  point(world, `journal:${phase}:after`)
  return next
}

/** The move as its driver must run it: commit only from `blobs-transferred`. */
async function runMove(world: World, migrationId: string): Promise<void> {
  const target = destination(world)
  const seed = wslMoveCutoverFixture(migrationId, 'prepared')
  point(world, 'journal:prepared:before')
  writeWslMoveCutover(world.userDataPath, seed)
  point(world, 'journal:prepared:after')
  let cutover = advance(world, seed, 'source-fenced')
  point(world, 'quiesce:sleep')
  cutover = advance(world, cutover, 'quiesced')
  await target.stage(cutover.manifest)
  cutover = advance(world, cutover, 'destination-staged')
  point(world, 'blob-chunk')
  cutover = advance(world, cutover, 'blobs-transferred')
  assertWslMoveCommitRequestAllowed(cutover)
  await target.commit(cutover.manifest)
  cutover = advance(world, cutover, 'destination-committed')
  await runWslMoveDesktopRewritePass({ userDataPath: world.userDataPath, warn: () => {} })
  const rewritten = listWslMoveCutovers(world.userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (rewritten?.phase !== 'client-rewritten') {
    throw new Crash('rewrite-paused')
  }
  advance(world, rewritten, 'retained')
}

/** App restart, then the WSL host answering: the two moments recovery runs. */
async function restartAndReconnect(
  world: World,
  hostReachable: boolean,
  carriesManifest = true
): Promise<void> {
  world.carriesManifest = carriesManifest
  await recoverInterruptedWslMoves(world.userDataPath, () => {})
  if (hostReachable) {
    for (const cutover of listWslMoveCutovers(world.userDataPath)) {
      await resetWslMoveToZero(
        { userDataPath: world.userDataPath, destination: destination(world) },
        cutover.migrationId
      )
    }
  }
  await runWslMoveDesktopRewritePass({ userDataPath: world.userDataPath, warn: () => {} })
  for (const cutover of listWslMoveCutovers(world.userDataPath)) {
    if (cutover.phase === 'client-rewritten') {
      writeWslMoveCutover(world.userDataPath, { ...cutover, phase: 'retained' })
    }
  }
}

type Outcome = 'back-at-zero' | 'fully-moved' | 'waiting-for-host' | 'stuck'

function outcomeOf(world: World): Outcome {
  const records = listWslMoveCutovers(world.userDataPath)
  const fence = resolveWslMoveFence(world.userDataPath)
  const committed = [...world.catalog].filter(([, state]) => state === 'committed')
  if (records.length === 0) {
    const clean =
      committed.length === 0 &&
      fence.fenced.repoIds.size === 0 &&
      fence.hidden.repoIds.size === 0 &&
      fence.sessionFrozen.repoIds.size === 0 &&
      world.rewritten.size === 0
    return clean ? 'back-at-zero' : 'stuck'
  }
  const [record] = records
  if (
    records.length === 1 &&
    record?.phase === 'retained' &&
    committed.length === 1 &&
    committed[0]?.[0] === record.migrationId
  ) {
    const allOnce = STORE_IDS.every((id) => world.rewritten.get(id) === 1)
    return allOnce && fence.hidden.repoIds.has('repo-1') && fence.fenced.repoIds.size === 0
      ? 'fully-moved'
      : 'stuck'
  }
  if (records.length === 1 && record?.phase === 'blobs-transferred') {
    return 'waiting-for-host'
  }
  return 'stuck'
}

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-faults-'))
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  setWslMoveDesktopRewriteRegistryCompleteForTests(true)
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

/** A new profile and an empty store registry, still complete as 7f will make it. */
function freshProfile(): void {
  resetWslMoveDesktopRewriteStoresForTests()
  setWslMoveDesktopRewriteRegistryCompleteForTests(true)
  rmSync(userDataPath, { recursive: true, force: true })
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-faults-'))
}

function newWorld(crashAt: string | null): World {
  return {
    userDataPath,
    crashAt,
    points: [],
    catalog: new Map(),
    carriesManifest: true,
    rewritten: new Map()
  }
}

/** Every crash point a clean move passes through. */
async function crashPoints(): Promise<string[]> {
  const world = newWorld(null)
  registerStores(world)
  await runMove(world, 'probe')
  freshProfile()
  return world.points.filter((name) => name !== 'journal:retained:after')
}

describe('WSL move fault injection', () => {
  it('a clean move ends fully moved', async () => {
    const world = newWorld(null)
    registerStores(world)
    await runMove(world, 'move-1')
    expect(outcomeOf(world)).toBe('fully-moved')
  })

  // About 25 whole moves on a real disk journal; the default budget is for single cases.
  it(
    'every crash point ends back at zero or fully moved once the host answers',
    { timeout: 60_000 },
    async () => {
      const points = await crashPoints()
      expect(points.length).toBeGreaterThan(20)
      const matrix: Record<string, { hostDown: Outcome; hostUp: Outcome }> = {}
      for (const crashAt of points) {
        const world = newWorld(crashAt)
        registerStores(world)
        await expect(runMove(world, 'move-1')).rejects.toBeInstanceOf(Crash)
        await restartAndReconnect(world, false)
        const hostDown = outcomeOf(world)
        await restartAndReconnect(world, true)
        const hostUp = outcomeOf(world)
        matrix[crashAt] = { hostDown, hostUp }
        if (hostUp === 'back-at-zero') {
          // Reset means a fresh move succeeds from scratch.
          await runMove(world, 'move-2')
          expect(outcomeOf(world), `fresh move after ${crashAt}`).toBe('fully-moved')
        }
        freshProfile()
      }
      for (const [crashAt, result] of Object.entries(matrix)) {
        expect(['back-at-zero', 'fully-moved'], `${crashAt} with the host up`).toContain(
          result.hostUp
        )
        // Without the host, only a possible commit may wait; everything else resolves locally.
        expect(['back-at-zero', 'fully-moved', 'waiting-for-host'], crashAt).toContain(
          result.hostDown
        )
      }
      // The commit point: crashes before the commit request reset, crashes after it move forward.
      expect(matrix['commit:before']).toEqual({
        hostDown: 'waiting-for-host',
        hostUp: 'back-at-zero'
      })
      expect(matrix['commit:lost-reply']).toEqual({
        hostDown: 'waiting-for-host',
        hostUp: 'fully-moved'
      })
      expect(matrix['journal:quiesced:after']?.hostDown).toBe('back-at-zero')
      expect(matrix['store:sessions:flush']).toEqual({
        hostDown: 'fully-moved',
        hostUp: 'fully-moved'
      })
    }
  )

  // Why: a journal can hold a manifest the host's request limit no longer carries (#30836); a
  // reset that could only abort inline would then leave the project read-only for good.
  it(
    'every crash point still resolves when the host can no longer take the manifest inline',
    { timeout: 60_000 },
    async () => {
      const points = await crashPoints()
      for (const crashAt of points) {
        const world = newWorld(crashAt)
        registerStores(world)
        await expect(runMove(world, 'move-1')).rejects.toBeInstanceOf(Crash)
        await restartAndReconnect(world, true, false)
        expect(['back-at-zero', 'fully-moved'], crashAt).toContain(outcomeOf(world))
        freshProfile()
      }
    }
  )
})
