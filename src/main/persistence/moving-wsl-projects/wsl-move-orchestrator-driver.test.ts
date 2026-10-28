/**
 * The move orchestrator (D3a) over the real move driver and journal: only the WSL host and the
 * terminals are faked (the driver tests' world), so the orchestrator's reading of every driver
 * outcome is checked against what the driver actually returns.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import {
  WSL_MOVE_CUTOVER_PHASES,
  wslMoveJournalKey
} from '../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveOrchestratorRecord } from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import {
  createWslMoveWorld,
  WSL_MOVE_WORLD_PANE,
  type WslMoveWorld
} from '../__fixtures__/wsl-mover/wsl-move-driver-world'
import { listWslMoveCutoverChain, listWslMoveCutovers } from './wsl-move-cutover-journal'
import {
  registerWslMoveDesktopRewriteStore,
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests
} from './wsl-move-desktop-rewrite-stores'
import { moveProjectsToWslHost, previewWslMove } from './wsl-move-driver'
import { WslMoveOrchestrator } from './wsl-move-orchestrator'
import type { WslMoveOrchestratorPorts } from './wsl-move-orchestrator-ports'
import {
  WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS,
  WSL_MOVE_ORCHESTRATOR_UNCOUNTED_RETRY_MS
} from './wsl-move-orchestrator-transitions'
import { runWslMoveRetentionPass } from './wsl-move-retention'
import { bringWslMovedProjectBack } from './wsl-move-use-locally'
import { resetWslMoveWindowWriteHoldForTests } from './wsl-move-window-write-hold'

const COMMITTED_FROM = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')

let userDataPath: string
let world: WslMoveWorld

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-orchestrator-driver-'))
  world = createWslMoveWorld(userDataPath)
  setWslMoveDesktopRewriteRegistryCompleteForTests(true)
  registerWslMoveDesktopRewriteStore({
    id: 'ui-routing',
    side: 'main',
    run: () => {},
    flush: () => {}
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  resetWslMoveWindowWriteHoldForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

/** The orchestrator's production ports, with the driver and journal real and the host faked. */
function orchestratorOverDriver(): {
  orchestrator: WslMoveOrchestrator
  advance: (ms: number) => Promise<void>
} {
  const clock = { now: 1_000 }
  const timers: { at: number; run: () => void }[] = []
  let saved = new Map<string, WslMoveOrchestratorRecord>()
  const ports: WslMoveOrchestratorPorts = {
    now: () => clock.now,
    appVersion: '1.0.0',
    autoMoveEnabled: () => true,
    prepareHost: async () => 'ready',
    hostRemovalPending: () => false,
    hasHost: () => true,
    isHostReady: () => true,
    preview: (distro) => previewWslMove(world.deps, { distro }),
    start: async (distro, stillWanted) =>
      stillWanted()
        ? moveProjectsToWslHost(world.deps, { distro })
        : { outcome: 'refused', code: 'wsl_move_cancelled' },
    // As the wiring reads it: the newest committed move of the distro's chain.
    finishedMove: (distro) => {
      const move = listWslMoveCutoverChain(userDataPath, wslMoveJournalKey(distro)).findLast(
        (cutover) => WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase) >= COMMITTED_FROM
      )
      return move ? { migrationId: move.migrationId } : null
    },
    checkMovedDistro: async () => 'present',
    releaseFinishedMove: async () => ({ released: false, reason: 'not-moved' }),
    load: () => saved,
    save: (records) => {
      saved = new Map(records)
    },
    schedule: (delayMs, run) => {
      const timer = { at: clock.now + delayMs, run }
      timers.push(timer)
      return () => {
        timers.splice(timers.indexOf(timer), 1)
      }
    },
    track: () => {},
    publish: () => {}
  }
  const orchestrator = new WslMoveOrchestrator(ports)
  return {
    orchestrator,
    advance: async (ms) => {
      clock.now += ms
      for (const timer of timers.filter((entry) => entry.at <= clock.now)) {
        timers.splice(timers.indexOf(timer), 1)
        timer.run()
      }
      await orchestrator.whenIdle()
    }
  }
}

function stateOf(orchestrator: WslMoveOrchestrator) {
  return orchestrator.list().find((record) => record.distro === 'Ubuntu')?.state
}

describe('the move orchestrator over the real driver', () => {
  it('moves a distro on a wake and records the journal migration it finished', async () => {
    const { orchestrator } = orchestratorOverDriver()
    await orchestrator.trigger('Ubuntu', 'project-opened')
    const committed = listWslMoveCutovers(userDataPath)
    expect(committed).toHaveLength(1)
    expect(stateOf(orchestrator)).toEqual({ kind: 'done', migrationId: committed[0]?.migrationId })
    expect([...world.catalog.values()]).toEqual(['committed'])
  })

  it('defers on the driver blockers, then moves on the re-check once the terminals are free', async () => {
    world.gate = {
      panes: [
        {
          paneKey: WSL_MOVE_WORLD_PANE,
          foreground: 'process-running',
          agent: { state: 'working', resumable: true, ownsForeground: true },
          scrollbackBytes: 0
        }
      ],
      runningAutomationRunIds: [],
      activeDispatchIds: []
    }
    const { orchestrator, advance } = orchestratorOverDriver()
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator)).toMatchObject({
      kind: 'deferred',
      blockers: [{ kind: 'agent-working', ids: [WSL_MOVE_WORLD_PANE] }]
    })
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
    world.gate = { panes: [], runningAutomationRunIds: [], activeDispatchIds: [] }
    await advance(WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS[0])
    expect(stateOf(orchestrator)).toMatchObject({ kind: 'done' })
  })

  it('backs off a move the driver reset before the host committed it, leaving no journal', async () => {
    world.failAt.add('prove-exited')
    const { orchestrator, advance } = orchestratorOverDriver()
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator)).toMatchObject({ kind: 'backoff' })
    expect(orchestrator.list()[0]?.attempts).toBe(1)
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
    await advance(60_000)
    expect(stateOf(orchestrator)).toMatchObject({ kind: 'done' })
  })

  // The driver itself refuses as already in flight until retention marks the move retained.
  it('waits out the real in-flight refusal while the move is retained, staying done', async () => {
    const { orchestrator, advance } = orchestratorOverDriver()
    await orchestrator.trigger('Ubuntu', 'connect')
    const migrationId = listWslMoveCutovers(userDataPath)[0]?.migrationId
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).not.toBe('retained')
    expect(await previewWslMove(world.deps, { distro: 'Ubuntu' })).toMatchObject({
      outcome: 'refused',
      code: 'wsl_move_already_in_flight'
    })
    await orchestrator.trigger('Ubuntu', 'project-opened')
    expect(stateOf(orchestrator)).toMatchObject({ kind: 'done', migrationId, waits: 1 })
    expect(orchestrator.list()[0]?.attempts).toBe(0)
    await runWslMoveRetentionPass({
      userDataPath,
      store: {
        getRepos: () => world.repos,
        getFolderWorkspaces: () => [],
        setWslMoveRetainedMarks: vi.fn(() => 1),
        flushPendingOrThrowAsync: vi.fn(async () => {})
      }
    })
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('retained')
    await advance(WSL_MOVE_ORCHESTRATOR_UNCOUNTED_RETRY_MS)
    expect(stateOf(orchestrator)).toEqual({ kind: 'done', migrationId })
    expect(listWslMoveCutovers(userDataPath)).toHaveLength(1)
  })

  it('never moves again after the user brings the project back', async () => {
    const { orchestrator } = orchestratorOverDriver()
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(bringWslMovedProjectBack(userDataPath, { repoId: 'repo-1' }).released).toBe(true)
    orchestrator.releasedByUser('Ubuntu')
    const stagedBefore = world.points.filter((point) => point === 'stage:before').length
    await orchestrator.trigger('Ubuntu', 'project-opened')
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator)).toEqual({ kind: 'parked', reason: 'declined' })
    expect(world.points.filter((point) => point === 'stage:before').length).toBe(stagedBefore)
  })
})
