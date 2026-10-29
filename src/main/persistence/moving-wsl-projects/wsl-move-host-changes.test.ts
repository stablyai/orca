/**
 * The WSL host changing under a move, against a real orcad profile store.
 * R41: orcad updated mid-move, by this desktop's next connect or by another desktop on the distro.
 * R38: the distro unregistered (or renamed: by name the two look the same) mid-move or after it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import {
  createStore,
  readPersistedStateJson,
  testState,
  writeDataFile
} from '../persistence-test-harness'
import {
  createWslMoveKillRig,
  removeWslMoveRigDirs,
  restartWslMoveRig,
  WSL_MOVE_RIG_REQUEST as request,
  wslMoveRigOutcome as outcomeOf,
  wslMoveRigRetentionStore,
  wslMoveRigTempDir,
  type WslMoveRig
} from '../__fixtures__/wsl-mover/wsl-move-kill-rig'
import { isRecord } from './wsl-move-canonical-form'
import { listWslMoveCutovers, removeWslMoveCutover } from './wsl-move-cutover-journal'
import { resetWslMoveDesktopRewriteStoresForTests } from './wsl-move-desktop-rewrite-stores'
import { moveProjectsToWslHost } from './wsl-move-driver'
import { resolveWslMoveFence } from './wsl-move-fence'
import { listWslMoveOwedHostAborts } from './wsl-move-owed-host-aborts'
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

const retain = () =>
  runWslMoveRetentionPass({ userDataPath: rig.userDataPath, store: wslMoveRigRetentionStore(rig) })

/** When the move reaches `point`, run `change` once. */
function at(point: string, change: () => void): void {
  rig.kill.onPoint = (name) => {
    if (name === point) {
      rig.kill.onPoint = undefined
      change()
    }
  }
}

/** The stage is in a format this orcad cannot read, as when versions differ: it is dropped on load. */
function replaceOrcadWithNewerStagingFormat(): void {
  const persisted: unknown = JSON.parse(readPersistedStateJson())
  const state = isRecord(persisted) ? persisted : {}
  const staged = state.orcadMigrationStagedCatalogs
  for (const entry of Array.isArray(staged) ? staged : []) {
    if (isRecord(entry)) {
      entry.version = 2
    }
  }
  writeDataFile(state)
  rig.host = createStore()
}

describe('R41: orcad updated during a move', () => {
  it('between staging and the commit, with the same staging format: the move finishes', async () => {
    at('blob:terminal-history:before', () => {
      rig.host = createStore()
    })
    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({
      outcome: 'moved'
    })
    await retain()
    expect(outcomeOf(rig)).toBe('fully-moved')
  })

  it('between staging and the commit, by a build that cannot read the stage: back to zero, then a retry moves', async () => {
    at('blob:terminal-history:before', replaceOrcadWithNewerStagingFormat)
    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({
      outcome: 'reset'
    })
    // The new orcad answered "absent", so nothing is owed to it.
    expect(outcomeOf(rig)).toBe('back-at-zero')

    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({
      outcome: 'moved'
    })
  })

  it.each(['commit:lost-reply', 'store:main-profile:run', 'store:browser:flush'])(
    'between the commit and the desktop rewrite (%s), with the app updated too: fully moved',
    async (killAt) => {
      rig.kill.killAt = killAt
      await moveProjectsToWslHost(rig.world.deps, request).catch(() => {})
      expect(rig.kill.dead).toBe(true)
      // App update = restart; orcad updated on the next connect. The receipt survives it.
      await restartWslMoveRig(rig, { hostUp: false, orcadRestarted: true })
      await restartWslMoveRig(rig, { hostUp: true, orcadRestarted: true })
      expect(outcomeOf(rig)).toBe('fully-moved')
    }
  )
})

describe('R38: the distro unregistered or renamed', () => {
  /** A fresh distro registered under the same name: a new, empty orcad. */
  function registerFreshDistro(): void {
    testState.dir = wslMoveRigTempDir('wsl-move-fresh-host-')
    rig.host = createStore()
    rig.hostPresent = true
  }

  it('before the commit request: back to zero; the leftover stage is owed to the next host', async () => {
    at('blob:terminal-history:before', () => {
      rig.hostPresent = false
    })
    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({
      outcome: 'reset'
    })
    expect(listWslMoveCutovers(rig.userDataPath)).toEqual([])
    expect(resolveWslMoveFence(rig.userDataPath).fenced.repoIds.size).toBe(0)
    expect(listWslMoveOwedHostAborts(rig.userDataPath)).toHaveLength(1)

    registerFreshDistro()
    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({
      outcome: 'moved'
    })
    expect(listWslMoveOwedHostAborts(rig.userDataPath)).toEqual([])
  })

  it('after the commit request: waits for the host, then resets once the distro is proven gone', async () => {
    at('commit:before', () => {
      rig.hostPresent = false
    })
    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({
      outcome: 'waiting-for-host'
    })
    expect(outcomeOf(rig)).toBe('waiting-for-host')

    // Registrations unreadable: never a guess, still waiting.
    rig.world.deps.isDistroRegistered = async () => null
    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({
      outcome: 'refused',
      code: 'wsl_move_host_unavailable'
    })
    expect(outcomeOf(rig)).toBe('waiting-for-host')

    rig.world.deps.isDistroRegistered = async () => false
    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({
      outcome: 'refused',
      code: 'wsl_move_host_unavailable',
      detail: 'distro_unregistered'
    })
    expect(listWslMoveCutovers(rig.userDataPath)).toEqual([])
    expect(resolveWslMoveFence(rig.userDataPath).fenced.repoIds.size).toBe(0)
  })

  it('after the commit request, when the kept host record fails to connect: resets once proven gone', async () => {
    at('commit:before', () => {
      rig.hostPresent = false
    })
    await moveProjectsToWslHost(rig.world.deps, request)
    // Production keeps the host record; its connect throws rather than answering null.
    rig.world.deps.connectHost = async () => {
      throw new Error('wsl_host_not_connected')
    }
    rig.world.deps.isDistroRegistered = async () => false

    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({
      outcome: 'refused',
      detail: 'distro_unregistered'
    })
    expect(listWslMoveCutovers(rig.userDataPath)).toEqual([])
  })

  it('after the commit request, a renamed distro (its GUID still registered) keeps waiting', async () => {
    at('commit:before', () => {
      rig.hostPresent = false
    })
    await moveProjectsToWslHost(rig.world.deps, request)
    const asked: (string | undefined)[] = []
    rig.world.deps.isDistroRegistered = async (_distro, guid) => {
      asked.push(guid)
      return true
    }

    await moveProjectsToWslHost(rig.world.deps, request)
    expect(outcomeOf(rig)).toBe('waiting-for-host')
    expect(asked).toHaveLength(1)
  })

  it('after the commit request, across a restart: startup resets once the distro is proven gone', async () => {
    rig.kill.killAt = 'commit:before'
    await moveProjectsToWslHost(rig.world.deps, request).catch(() => {})
    rig.hostPresent = false
    await restartWslMoveRig(rig, { hostUp: false, orcadRestarted: false })

    expect(listWslMoveCutovers(rig.userDataPath)).toEqual([])
    expect(resolveWslMoveFence(rig.userDataPath).fenced.repoIds.size).toBe(0)
  })

  it('after the move: the retained rows stay, and "Use on this computer again" needs no host', async () => {
    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({
      outcome: 'moved'
    })
    await retain()
    rig.hostPresent = false
    await restartWslMoveRig(rig, { hostUp: false, orcadRestarted: false })

    // A committed move is never reset by a lost distro: the host may only be renamed.
    const [cutover] = listWslMoveCutovers(rig.userDataPath)
    expect(cutover?.phase).toBe('retained')
    expect(resolveWslMoveFence(rig.userDataPath).hidden.repoIds.has('repo-1')).toBe(true)
    expect(rig.world.repos.map((repo) => repo.id)).toEqual(['repo-1'])

    // The escape hatch (#29833) drops the newest committed move locally.
    removeWslMoveCutover(rig.userDataPath, cutover.migrationId)
    await retain()
    expect(resolveWslMoveFence(rig.userDataPath).hidden.repoIds.size).toBe(0)
  })
})
