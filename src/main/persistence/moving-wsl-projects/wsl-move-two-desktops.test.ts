/**
 * R39: two Orca desktops (say a stable and a dev profile) moving into the one orcad of a distro.
 * Each desktop is its own process with its own profile and journal, so desktop B runs on a second
 * copy of the mover modules. The host's staging claims serialize overlapping moves: one wins, the
 * other is refused and back at zero; neither corrupts the other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import { testState } from '../persistence-test-harness'
import type { Store } from '../loading-store/store'
import {
  createWslMoveKillRig,
  removeWslMoveRigDirs,
  WSL_MOVE_RIG_REQUEST as request,
  wslMoveRigOutcome,
  wslMoveRigRetentionStore,
  wslMoveRigTempDir,
  type WslMoveRig
} from '../__fixtures__/wsl-mover/wsl-move-kill-rig'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import { resetWslMoveDesktopRewriteStoresForTests } from './wsl-move-desktop-rewrite-stores'
import { moveProjectsToWslHost } from './wsl-move-driver'
import type { WslMoveResult } from '../../../shared/wsl-move/wsl-move-driver-types'
import type { Repo } from '../../../shared/repo-types'
import { runWslMoveRetentionPass } from './wsl-move-retention'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 1 }))
}))

type OtherDesktop = {
  userDataPath: string
  repos: Repo[]
  move: () => Promise<WslMoveResult>
  retain: () => Promise<void>
  journalPhases: () => string[]
}

/** Desktop B: its own module copies, profile and journal, on desktop A's host store. */
async function otherDesktop(host: () => Store, repos: Repo[]): Promise<OtherDesktop> {
  vi.resetModules()
  const driver = await import('./wsl-move-driver')
  const stores = await import('./wsl-move-desktop-rewrite-stores')
  const journal = await import('./wsl-move-cutover-journal')
  const retention = await import('./wsl-move-retention')
  const worldModule = await import('../__fixtures__/wsl-mover/wsl-move-driver-world')
  const hostModule = await import('../__fixtures__/wsl-mover/wsl-move-store-host')
  stores.setWslMoveDesktopRewriteRegistryCompleteForTests(true)
  stores.registerWslMoveDesktopRewriteStore({
    id: 'ui-routing',
    side: 'main',
    run: () => {},
    flush: () => {}
  })
  const userDataPath = wslMoveRigTempDir('wsl-move-desktop-b-')
  const world = worldModule.createWslMoveWorld(userDataPath)
  world.repos.splice(0, world.repos.length, ...repos)
  // Its own ids: a second profile never shares this desktop's random move ids.
  let moves = 0
  world.deps.newMigrationId = () => `desktop-b-move-${(moves += 1)}`
  const port = hostModule.createWslMoveStoreHost({
    store: host,
    kill: hostModule.createWslMoveKillSwitch(),
    prefix: 'b:'
  })
  world.deps.connectHost = async () => port
  return {
    userDataPath,
    repos: world.repos,
    move: () => driver.moveProjectsToWslHost(world.deps, request),
    retain: async () => {
      await retention.runWslMoveRetentionPass({
        userDataPath,
        store: {
          getRepos: () => world.repos,
          getFolderWorkspaces: () => [],
          setWslMoveRetainedMarks: () => 1,
          flushPendingOrThrowAsync: async () => {}
        }
      })
    },
    journalPhases: () => journal.listWslMoveCutovers(userDataPath).map((entry) => entry.phase)
  }
}

let rig: WslMoveRig

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  rig = createWslMoveKillRig()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  removeWslMoveRigDirs()
})

/** Desktop A's move, held just before its commit until `release` runs. */
function pausedBeforeCommit(): {
  paused: Promise<void>
  release: () => void
  done: Promise<WslMoveResult>
} {
  let release = (): void => {}
  let onPaused = (): void => {}
  const paused = new Promise<void>((resolve) => (onPaused = resolve))
  const gate = new Promise<void>((resolve) => (release = resolve))
  const { proveExited } = rig.world.deps.quiesce
  let calls = 0
  rig.world.deps.quiesce.proveExited = async (scope) => {
    calls += 1
    // The second proof runs after every blob and right before the commit request.
    if (calls === 2) {
      onPaused()
      await gate
    }
    return proveExited(scope)
  }
  return { paused, release, done: moveProjectsToWslHost(rig.world.deps, request) }
}

describe('R39: two desktops moving into one distro', () => {
  it('the same project from both: the later stage is refused and resets; the first finishes', async () => {
    const a = pausedBeforeCommit()
    await a.paused
    const b = await otherDesktop(() => rig.host, [...rig.world.repos])

    const bResult = await b.move()
    expect(bResult).toMatchObject({ outcome: 'reset' })
    expect(JSON.stringify(bResult)).toContain('orcad_migration_staged_claim_conflict')
    expect(b.journalPhases()).toEqual([])

    a.release()
    expect(await a.done).toMatchObject({ outcome: 'moved' })
    await runWslMoveRetentionPass({
      userDataPath: rig.userDataPath,
      store: wslMoveRigRetentionStore(rig)
    })
    expect(wslMoveRigOutcome(rig)).toBe('fully-moved')
    expect(rig.host.getRepos().filter((repo) => repo.id === 'repo-1')).toHaveLength(1)
  })

  it('the same project again after the first committed: refused, and the host copy is untouched', async () => {
    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({ outcome: 'moved' })
    const hostBefore = JSON.stringify(rig.host.getRepos())
    const b = await otherDesktop(() => rig.host, [...rig.world.repos])

    expect(await b.move()).toMatchObject({ outcome: 'refused', code: 'wsl_move_nothing_new' })
    expect(b.journalPhases()).toEqual([])
    expect(JSON.stringify(rig.host.getRepos())).toBe(hostBefore)
    expect(listWslMoveCutovers(rig.userDataPath).map((entry) => entry.phase)).toEqual([
      'client-rewritten'
    ])
  })

  it('the same folder under another id (each profile added it): refused after the first committed', async () => {
    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({ outcome: 'moved' })
    const hostBefore = JSON.stringify(rig.host.getRepos())
    const b = await otherDesktop(() => rig.host, [{ ...rig.world.repos[0], id: 'repo-b-profile' }])

    expect(await b.move()).toMatchObject({
      outcome: 'reset',
      detail: 'orcad_migration_repository_path_conflict:/home/dev/app'
    })
    expect(b.journalPhases()).toEqual([])
    expect(JSON.stringify(rig.host.getRepos())).toBe(hostBefore)
  })

  it('the same folder under another id, overlapping: the later stage is refused', async () => {
    const a = pausedBeforeCommit()
    await a.paused
    const b = await otherDesktop(() => rig.host, [{ ...rig.world.repos[0], id: 'repo-b-profile' }])

    const bResult = await b.move()
    expect(bResult).toMatchObject({ outcome: 'reset' })
    expect(JSON.stringify(bResult)).toContain(
      'orcad_migration_staged_claim_conflict:repository-path'
    )
    a.release()
    expect(await a.done).toMatchObject({ outcome: 'moved' })
  })

  it('different projects from each, overlapping: both move, and the host holds both', async () => {
    const a = pausedBeforeCommit()
    await a.paused
    const b = await otherDesktop(
      () => rig.host,
      [{ ...rig.world.repos[0], id: 'repo-2', path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\other' }]
    )

    expect(await b.move()).toMatchObject({ outcome: 'moved' })
    a.release()
    expect(await a.done).toMatchObject({ outcome: 'moved' })
    expect(
      rig.host
        .getRepos()
        .map((repo) => repo.id)
        .sort()
    ).toEqual(['repo-1', 'repo-2'])
  })
})
