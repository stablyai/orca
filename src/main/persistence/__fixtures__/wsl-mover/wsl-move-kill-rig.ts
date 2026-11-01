/**
 * One desktop moving one project into a WSL host backed by a real orcad profile store, with every
 * step a kill point (wsl-move-store-host). Shared by the fault, update, lost-distro and
 * two-desktop tests. A test file mocks the journal itself and points its hook at `rig.at`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wslMoveJournalKey } from '../../../../shared/wsl-move/wsl-move-cutover'
import { createStore, testState } from '../../persistence-test-harness'
import type { Store } from '../../loading-store/store'
import {
  listWslMoveCutoverChain,
  listWslMoveCutovers
} from '../../moving-wsl-projects/wsl-move-cutover-journal'
import { runWslMoveDesktopRewritePass } from '../../moving-wsl-projects/wsl-move-desktop-rewrite'
import {
  registerWslMoveDesktopRewriteStore,
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests
} from '../../moving-wsl-projects/wsl-move-desktop-rewrite-stores'
import { resolveWslMoveFence } from '../../moving-wsl-projects/wsl-move-fence'
import {
  listWslMoveOwedHostAborts,
  settleWslMoveOwedHostAborts
} from '../../moving-wsl-projects/wsl-move-owed-host-aborts'
import {
  recoverInterruptedWslMoves,
  resetWslMoveToZero
} from '../../moving-wsl-projects/wsl-move-reset'
import { runWslMoveRetentionPass } from '../../moving-wsl-projects/wsl-move-retention'
import { createWslMoveWorld, type WslMoveWorld } from './wsl-move-driver-world'
import {
  createWslMoveKillSwitch,
  createWslMoveStoreHost,
  passWslMoveKillPoint,
  type WslMoveKillSwitch
} from './wsl-move-store-host'

export const WSL_MOVE_RIG_STORE_IDS = ['main-profile', 'renderer-ui', 'browser'] as const
export const WSL_MOVE_RIG_REQUEST = { distro: 'Ubuntu' }

/** `zero-abort-owed`: the desktop is at zero; the host's leftover stage goes on its next contact. */
export type WslMoveRigOutcome =
  | 'back-at-zero'
  | 'zero-abort-owed'
  | 'fully-moved'
  | 'waiting-for-host'
  | 'stuck'

export type WslMoveRig = {
  userDataPath: string
  kill: WslMoveKillSwitch
  world: WslMoveWorld
  /** The host's current store; an orcad restart replaces it. */
  host: Store
  /** False while the distro is unregistered: the host neither connects nor answers. */
  hostPresent: boolean
  rewritten: Map<string, number>
  at: (name: string) => void
}

const dirs: string[] = []

export function wslMoveRigTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

export function removeWslMoveRigDirs(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A fresh profile and host, with this rig's rewrite stores as the only registered ones. */
export function createWslMoveKillRig(): WslMoveRig {
  resetWslMoveDesktopRewriteStoresForTests()
  setWslMoveDesktopRewriteRegistryCompleteForTests(true)
  testState.dir = wslMoveRigTempDir('wsl-move-host-')
  const userDataPath = wslMoveRigTempDir('wsl-move-desktop-')
  const kill = createWslMoveKillSwitch()
  const world = createWslMoveWorld(userDataPath)
  const at = (name: string): void => passWslMoveKillPoint(kill, name)
  const rig: WslMoveRig = {
    userDataPath,
    kill,
    world,
    host: createStore(),
    hostPresent: true,
    rewritten: new Map(),
    at
  }
  const host = createWslMoveStoreHost({
    store: () => rig.host,
    kill,
    available: () => rig.hostPresent
  })
  world.deps.connectHost = async () => {
    at('connect')
    return rig.hostPresent ? host : null
  }
  world.deps.isDistroRegistered = async () => rig.hostPresent
  const { quiesce } = world.deps
  world.deps.quiesce = {
    sleepWorkspaces: async (ids) => (at('sleep'), quiesce.sleepWorkspaces(ids)),
    livePtyIds: quiesce.livePtyIds,
    captureRestoreHints: async (panes, distro) => (
      at('restore-hints'),
      quiesce.captureRestoreHints(panes, distro)
    ),
    proveExited: async (scope) => (at('prove-exited'), quiesce.proveExited(scope))
  }
  for (const id of WSL_MOVE_RIG_STORE_IDS) {
    registerWslMoveDesktopRewriteStore({
      id,
      side: 'main',
      run: () => {
        at(`store:${id}:run`)
        rig.rewritten.set(id, 1)
      },
      flush: () => at(`store:${id}:flush`)
    })
  }
  return rig
}

export function wslMoveRigRetentionStore(rig: WslMoveRig) {
  return {
    getRepos: () => rig.world.repos,
    getFolderWorkspaces: () => [],
    setWslMoveRetainedMarks: () => 1,
    flushPendingOrThrowAsync: async () => {}
  }
}

/** orcad stopped and started again over the same disk, as an update or a distro restart does. */
export async function restartWslMoveRigHost(rig: WslMoveRig): Promise<void> {
  await rig.host.flushPendingOrThrowAsync().catch(() => {})
  rig.host = createStore()
}

/** Startup, then the user's next move attempt reaching the host (which settles the old one). */
export async function restartWslMoveRig(
  rig: WslMoveRig,
  options: { hostUp: boolean; orcadRestarted: boolean }
): Promise<void> {
  rig.kill.dead = false
  if (options.orcadRestarted) {
    await restartWslMoveRigHost(rig)
  }
  await recoverInterruptedWslMoves(rig.userDataPath, () => {}, rig.world.deps.isDistroRegistered)
  await runWslMoveDesktopRewritePass({ userDataPath: rig.userDataPath, warn: () => {} })
  if (options.hostUp) {
    // What the next move's prepare does once it reaches the host, before it stages anything.
    const key = wslMoveJournalKey(WSL_MOVE_RIG_REQUEST.distro)
    const host = await rig.world.deps.connectHost(WSL_MOVE_RIG_REQUEST.distro)
    if (host) {
      await settleWslMoveOwedHostAborts(rig.userDataPath, key, host.catalog)
    }
    const head = listWslMoveCutoverChain(rig.userDataPath, key).at(-1)
    if (head) {
      await resetWslMoveToZero(
        { userDataPath: rig.userDataPath, destination: host?.catalog ?? null },
        head.migrationId
      )
      await rig.world.deps.finishOnDesktop()
    }
  }
  await runWslMoveRetentionPass({
    userDataPath: rig.userDataPath,
    store: wslMoveRigRetentionStore(rig)
  })
}

export function wslMoveRigOutcome(rig: WslMoveRig): WslMoveRigOutcome {
  const records = listWslMoveCutovers(rig.userDataPath)
  const fence = resolveWslMoveFence(rig.userDataPath)
  const onHost = rig.host.getRepos().some((repo) => repo.id === 'repo-1')
  if (records.length === 0) {
    const staged = rig.host.hasStagedOrcadMigrationCatalog()
    const owed = listWslMoveOwedHostAborts(rig.userDataPath).length > 0
    const clean =
      !onHost &&
      (!staged || owed) &&
      fence.fenced.repoIds.size === 0 &&
      fence.hidden.repoIds.size === 0 &&
      fence.sessionFrozen.repoIds.size === 0 &&
      rig.rewritten.size === 0
    if (!clean) {
      return 'stuck'
    }
    return owed ? 'zero-abort-owed' : 'back-at-zero'
  }
  const [record] = records
  if (records.length === 1 && record.phase === 'retained') {
    const allOnce = WSL_MOVE_RIG_STORE_IDS.every((id) => rig.rewritten.get(id) === 1)
    return allOnce &&
      onHost &&
      fence.hidden.repoIds.has('repo-1') &&
      fence.fenced.repoIds.size === 0
      ? 'fully-moved'
      : 'stuck'
  }
  if (records.length === 1 && record.phase === 'blobs-transferred') {
    return 'waiting-for-host'
  }
  return 'stuck'
}
