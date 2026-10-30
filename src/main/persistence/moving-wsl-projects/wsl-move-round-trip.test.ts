/**
 * Round trip on every mover fixture, through the production code end to end: the real
 * export from a desktop profile store, the real driver, the real import into a host profile store,
 * the real retention marks. The host's state must project equal to the source's; then "Use on
 * this computer again" (dropping the retained move, as #29833 does) must give back the desktop's
 * catalog and session byte for byte, except the PTY bindings a move drops by definition.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { SESSION_FOCUS_FIELDS } from '../../../shared/workspace-session-host-field-ownership'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import { closeTestStores, testState } from '../persistence-test-harness'
import type { Store } from '../loading-store/store'
import { createWslMoveWorld } from '../__fixtures__/wsl-mover/wsl-move-driver-world'
import {
  WSL_MOVER_PROFILE_NAMES,
  wslMoverProfile,
  wslMoverProfileScope,
  type WslMoverProfileName
} from '../__fixtures__/wsl-mover/wsl-mover-profiles'
import {
  createWslMoveKillSwitch,
  createWslMoveStoreHost
} from '../__fixtures__/wsl-mover/wsl-move-store-host'
import {
  openWslMoveRoundTripStore,
  readWslMoveRoundTripStoreJson
} from '../__fixtures__/wsl-mover/wsl-move-round-trip-stores'
import {
  normalizeWslMoveRoundTripProjection,
  WSL_MOVE_ROUND_TRIP_KNOWN_GAPS,
  withoutParkedScrollbackRefs
} from '../__fixtures__/wsl-mover/wsl-move-round-trip-normalization'
import { isRecord } from './wsl-move-canonical-form'
import { listWslMoveCutovers, removeWslMoveCutover } from './wsl-move-cutover-journal'
import { runWslMoveDesktopRewritePass } from './wsl-move-desktop-rewrite'
import {
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests
} from './wsl-move-desktop-rewrite-stores'
import { moveProjectsToWslHost } from './wsl-move-driver'
import { exportWslMoveManifest } from './wsl-move-manifest-export'
import { registerWslMoveMainRewriteStores } from './wsl-move-main-rewrite-stores'
import { runWslMoveRetentionPass } from './wsl-move-retention'
import { loadWslMoveFence, resetWslMoveFenceForTests } from './wsl-move-scope-guard'
import { projectWslMoveState, WSL_MOVE_PROJECTED_STATE_FIELDS } from './wsl-move-state-projection'
import { WSL_MOVE_DROPPED_PTY_BINDING_KEYS } from '../../../shared/wsl-move/wsl-move-dispositions'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 1 }))
}))

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  setWslMoveDesktopRewriteRegistryCompleteForTests(true)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  resetWslMoveFenceForTests()
  await closeTestStores()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const DROPPED: ReadonlySet<string> = new Set(WSL_MOVE_DROPPED_PTY_BINDING_KEYS)

// Focus follows the move to the host and stays there: the host keeps its copy (#29833).
const FOCUS: ReadonlySet<string> = new Set(SESSION_FOCUS_FIELDS)

/**
 * The persisted catalog and local session, without the PTY bindings a move drops, and with keys
 * sorted: the session is recomposed around the moved rows, which reorders a record's keys.
 */
function sourceBytes(state: PersistedState): string {
  const kept: Record<string, unknown> = {}
  for (const field of [...WSL_MOVE_PROJECTED_STATE_FIELDS, 'workspaceSession'] as const) {
    kept[field] = state[field]
  }
  const session = kept.workspaceSession
  if (isRecord(session)) {
    kept.workspaceSession = Object.fromEntries(
      Object.entries(session)
        .filter(([field]) => !FOCUS.has(field))
        // A set of worktree ids; the recomposed session lists the unmoved ones first.
        .map(([field, value]) =>
          field === 'activeWorktreeIdsOnShutdown' && Array.isArray(value)
            ? [field, [...value].sort()]
            : [field, value]
        )
    )
  }
  return JSON.stringify(
    kept,
    (key, value: unknown) => {
      if (DROPPED.has(key)) {
        return undefined
      }
      return isRecord(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
        : value
    },
    1
  )
}

type RoundTrip = {
  desktop: Store
  host: Store
  userDataPath: string
  desktopDir: string
  hostDir: string
  before: PersistedState
  sourceSession: WorkspaceSessionState
}

function persistedState(dir: string): PersistedState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a Store wrote this profile; the projection reads only PersistedState fields.
  return JSON.parse(readWslMoveRoundTripStoreJson(dir)) as PersistedState
}

async function moveFixture(
  name: WslMoverProfileName,
  options: {
    /** What the host's own window focuses on before the move. */
    hostFocus?: Pick<WorkspaceSessionState, 'activeRepoId' | 'activeWorktreeId' | 'activeTabId'>
    /** Focus this desktop on the moving project, as when the user moves the one they have open. */
    focusMovedProject?: boolean
  } = {}
): Promise<RoundTrip> {
  const source = wslMoverProfile(name, 'source')
  if (options.focusMovedProject) {
    const movedRepoId = [...wslMoverProfileScope(name, 'source').repoIds][0]
    const movedWorktree = Object.keys(source.session.tabsByWorktree ?? {}).find((id) =>
      id.startsWith(`${movedRepoId}::`)
    )
    source.session = {
      ...source.session,
      activeRepoId: movedRepoId ?? null,
      activeWorktreeId: movedWorktree ?? null
    }
  }
  // Non-default repo settings, so a move that drops or changes them cannot pass as a default.
  const [first, ...rest] = source.state.repos
  source.state.repos = [
    {
      ...first,
      gitUsername: 'dev-user',
      hookSettings: {
        mode: 'auto',
        scripts: { setup: 'make bootstrap', archive: '' },
        setupRunPolicy: 'run-by-default',
        setupAgentStartupPolicy: 'start-immediately'
      }
    },
    ...rest
  ]
  const desktopDir = tempDir('wsl-round-trip-desktop-')
  const desktop = openWslMoveRoundTripStore(desktopDir, {
    ...getDefaultPersistedState(desktopDir),
    ...source.state,
    workspaceSession: {
      ...getDefaultPersistedState(desktopDir).workspaceSession,
      ...source.session
    },
    ...(source.ui ? { ui: { ...getDefaultPersistedState(desktopDir).ui, ...source.ui } } : {})
  } satisfies PersistedState)
  // A full write, so the source is the profile as the Store serializes it, like the host's.
  desktop.setMobileClientTabSelections(desktop.getMobileClientTabSelections())
  await desktop.flushPendingOrThrowAsync()
  const before = persistedState(desktopDir)
  const sourceSession = structuredClone(desktop.getWorkspaceSession())
  const hostDir = tempDir('wsl-round-trip-host-')
  const host = openWslMoveRoundTripStore(
    hostDir,
    options.hostFocus
      ? {
          ...getDefaultPersistedState(hostDir),
          workspaceSession: {
            ...getDefaultPersistedState(hostDir).workspaceSession,
            ...options.hostFocus
          }
        }
      : undefined
  )
  const userDataPath = desktopDir
  loadWslMoveFence(userDataPath)
  registerWslMoveMainRewriteStores(desktop)
  const world = createWslMoveWorld(userDataPath)
  const kill = createWslMoveKillSwitch()
  const hostPort = createWslMoveStoreHost({ store: () => host, kill })
  world.deps.connectHost = async () => hostPort
  world.deps.readCatalog = () => ({
    repos: desktop.getRepos(),
    folderWorkspaces: desktop.getFolderWorkspaces(),
    projectGroups: desktop.getProjectGroups()
  })
  world.deps.exportManifest = (request) => exportWslMoveManifest(desktop, request)
  world.deps.snapshots = desktop
  world.deps.finishOnDesktop = () => runWslMoveDesktopRewritePass({ userDataPath, warn: () => {} })
  const scope = wslMoverProfileScope(name, 'source')
  const result = await moveProjectsToWslHost(world.deps, {
    distro: scope.distro,
    repoIds: [...scope.repoIds],
    folderWorkspaceIds: [...scope.folderWorkspaceIds]
  })
  expect(result, `${name}: ${JSON.stringify(result)}`).toMatchObject({
    outcome: 'moved',
    phase: 'client-rewritten'
  })
  await runWslMoveRetentionPass({ userDataPath, store: desktop })
  await desktop.flushPendingOrThrowAsync()
  await host.flushPendingOrThrowAsync()
  return { desktop, host, userDataPath, desktopDir, hostDir, before, sourceSession }
}

const HOST = toRuntimeExecutionHostId('wsl:Ubuntu')

/** What the user sees after the move: the host's catalog, and the session the desktop renders. */
function destinationProjection(name: WslMoverProfileName, trip: RoundTrip): unknown {
  const hostPartition = trip.desktop.getWorkspaceSession(HOST)
  const local = trip.desktop.getWorkspaceSession()
  // Global fields are read from the local partition only (HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS).
  const session = { ...hostPartition, workspaceDocHistory: local.workspaceDocHistory }
  return projectWslMoveState(
    { state: persistedState(trip.hostDir), session },
    wslMoverProfileScope(name, 'destination')
  )
}

describe('WSL move round trip on every fixture', () => {
  it.each(WSL_MOVER_PROFILE_NAMES)(
    '%s: the host after the move projects equal to the source before it',
    async (name) => {
      const trip = await moveFixture(name)
      const source = projectWslMoveState(
        { state: trip.before, session: trip.sourceSession },
        wslMoverProfileScope(name, 'source')
      )
      const destination = destinationProjection(name, trip)
      const pick = (value: unknown, key: string): unknown =>
        isRecord(value) ? value[key] : undefined
      const sessionAfter = withoutParkedScrollbackRefs(
        pick(source, 'session'),
        pick(destination, 'session')
      )
      expect(sessionAfter, 'local-only scrollback became host snapshots').not.toBeNull()
      const expected = normalizeWslMoveRoundTripProjection(source)
      const actual = normalizeWslMoveRoundTripProjection(
        { ...(isRecord(destination) ? destination : {}), session: sessionAfter },
        source
      )
      for (const key of Object.keys(isRecord(expected) ? expected : {})) {
        expect.soft(pick(actual, key), key).toEqual(pick(expected, key))
      }
      // Automations arrive off and come back on through the ledgered host step, never silently.
      const enabled = (trip.before.automations ?? []).filter((automation) => automation.enabled)
      const [cutover] = listWslMoveCutovers(trip.userDataPath)
      expect([...(cutover?.automationsToReenable ?? [])].sort()).toEqual(
        enabled
          .map((automation) => automation.id)
          .filter((id) => persistedState(trip.hostDir).automations?.some((row) => row.id === id))
          .sort()
      )
    }
  )

  it.each(WSL_MOVER_PROFILE_NAMES)(
    '%s: "Use on this computer again" gives the source back byte for byte, without the host',
    async (name) => {
      const trip = await moveFixture(name)
      const [cutover] = listWslMoveCutovers(trip.userDataPath)
      expect(cutover?.phase).toBe('retained')
      // The escape hatch (#29833) drops the newest committed move; the host is never asked.
      removeWslMoveCutover(trip.userDataPath, cutover.migrationId)
      await runWslMoveRetentionPass({ userDataPath: trip.userDataPath, store: trip.desktop })
      await trip.desktop.flushPendingOrThrowAsync()
      expect(sourceBytes(persistedState(trip.desktopDir))).toEqual(sourceBytes(trip.before))
    }
  )

  // The project the user had open could not move into a host with its own focus.
  it('moves the focused project into a host that already has an active project, keeping its focus', async () => {
    const hostFocus = {
      activeRepoId: 'repo-already-on-host',
      activeWorktreeId: 'repo-already-on-host::/home/dev/other',
      activeTabId: 'host-tab'
    }
    const trip = await moveFixture('heavy-wsl', { hostFocus, focusMovedProject: true })
    expect(trip.sourceSession.activeRepoId).toBe(
      [...wslMoverProfileScope('heavy-wsl', 'source').repoIds][0]
    )
    // The host keeps its own focus (its unknown worktree id is dropped on load either way).
    expect(persistedState(trip.hostDir).workspaceSession).toMatchObject({
      activeRepoId: hostFocus.activeRepoId,
      activeTabId: hostFocus.activeTabId
    })
  })

  it('knows each listed gap still differs, so a fix must remove it from the list', async () => {
    const trip = await moveFixture('heavy-wsl')
    const source = projectWslMoveState(
      { state: trip.before, session: trip.sourceSession },
      wslMoverProfileScope('heavy-wsl', 'source')
    )
    const destination = destinationProjection('heavy-wsl', trip)
    const pick = (value: unknown, key: string): unknown =>
      isRecord(value) ? value[key] : undefined
    for (const field of Object.keys(WSL_MOVE_ROUND_TRIP_KNOWN_GAPS)) {
      expect
        .soft(pick(pick(destination, 'session'), field), field)
        .not.toEqual(pick(pick(source, 'session'), field))
    }
  })
})
