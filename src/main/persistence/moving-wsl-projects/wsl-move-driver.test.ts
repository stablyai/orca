import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import { computeOrcadMigrationManifestSha256 } from '../../orcad/orcad-migration-manifest-digest'
import {
  WSL_MOVE_WORLD_PANE,
  createWslMoveWorld,
  type WslMoveWorld
} from '../__fixtures__/wsl-mover/wsl-move-driver-world'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import { WslMoveScopeChangedError, type WslMoveManifestExport } from './wsl-move-manifest-export'
import {
  registerWslMoveDesktopRewriteStore,
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests
} from './wsl-move-desktop-rewrite-stores'
import { cancelWslMove, moveProjectsToWslHost, previewWslMove } from './wsl-move-driver'
import { runWslMoveRetentionPass } from './wsl-move-retention'
import { runWslMoveDesktopRewritePass } from './wsl-move-desktop-rewrite'
import {
  WSL_MOVE_HOST_AUTOMATIONS_STORE_ID,
  listUnfinishedWslMoves,
  registerWslMoveHostAutomationsStore,
  type WslMoveMovedAutomation
} from './wsl-move-host-automations-rewrite'
import { recoverInterruptedWslMoves } from './wsl-move-reset'
import {
  cancelWslMoveRewriteRetryForTests,
  scheduleWslMoveRewriteRetry
} from './wsl-move-rewrite-retry'

let userDataPath: string
let world: WslMoveWorld

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-driver-'))
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
  rmSync(userDataPath, { recursive: true, force: true })
})

const request = { distro: 'Ubuntu' }
const journal = () => listWslMoveCutovers(userDataPath)

describe('moveProjectsToWslHost', () => {
  it('moves a project to the host, through every phase, and retains its source row', async () => {
    const result = await moveProjectsToWslHost(world.deps, request)

    expect(result).toMatchObject({ outcome: 'moved', phase: 'client-rewritten' })
    // Sleep runs before the move is journaled, and again (a no-op) under the fence.
    expect(world.slept).toEqual([
      ['repo-1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'],
      ['repo-1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app']
    ])
    expect([...world.catalog.values()]).toEqual(['committed'])
    // The restore hints were sent from the journal, and the commit named them.
    expect(world.committedWithBlobs?.map((blob) => blob.blobKind)).toEqual([
      'terminal-restore-hints'
    ])
    const [cutover] = journal()
    expect(cutover.terminalRestoreHints).toEqual([
      { paneKey: WSL_MOVE_WORLD_PANE, cwd: '/home/dev/app/src' }
    ])
    expect(cutover.manifest.payload.repositories[0].path).toBe('/home/dev/app')
    expect(world.progress.map((event) => event.step)).toEqual([
      'preparing',
      'pausing-terminals',
      'copying',
      'copying',
      'copying',
      'switching',
      'finishing',
      'done'
    ])

    const store = {
      getRepos: () => world.repos,
      getFolderWorkspaces: () => [],
      setWslMoveRetainedMarks: vi.fn(() => 1),
      flushPendingOrThrowAsync: vi.fn(async () => {})
    }
    await runWslMoveRetentionPass({ userDataPath, store })
    expect(journal()[0].phase).toBe('retained')
    expect(store.setWslMoveRetainedMarks).toHaveBeenCalled()
  })

  it.each([
    ['stage:before', 'reset'],
    ['blob:terminal-restore-hints', 'reset'],
    ['commit:before', 'reset']
  ])('resets to zero when %s fails', async (failAt, outcome) => {
    world.failAt.add(failAt)
    const result = await moveProjectsToWslHost(world.deps, request)

    expect(result).toMatchObject({ outcome, detail: failAt })
    expect(journal()).toEqual([])
    // The host's staging was aborted; nothing of the move is left on either side.
    expect([...world.catalog.values()]).toEqual([])
  })

  it('recovers a stage whose reply was lost by reading the host, then moves', async () => {
    world.failAt.add('stage:lost-reply')
    expect(await moveProjectsToWslHost(world.deps, request)).toMatchObject({ outcome: 'moved' })
  })

  it('goes forward when the commit landed but its reply was lost', async () => {
    world.failAt.add('commit:lost-reply')
    const result = await moveProjectsToWslHost(world.deps, request)

    expect(result).toMatchObject({ outcome: 'moved', phase: 'client-rewritten' })
    expect([...world.catalog.values()]).toEqual(['committed'])
  })

  it('lifts the fence when the exit proof fails, before anything reaches the host', async () => {
    world.failAt.add('prove-exited')
    const result = await moveProjectsToWslHost(world.deps, request)

    expect(result).toMatchObject({ outcome: 'refused', code: 'wsl_move_pause_failed' })
    expect(journal()).toEqual([])
    expect(world.points).not.toContain('stage:before')
  })

  it('resets when the project changed while it was paused', async () => {
    world.exportOverride = (exported, call) =>
      call === 3
        ? {
            ...exported,
            manifest: { ...exported.manifest, manifestSha256: 'f'.repeat(64) }
          }
        : exported
    const result = await moveProjectsToWslHost(world.deps, request)

    expect(result).toEqual({ outcome: 'refused', code: 'wsl_move_scope_changed' })
    expect(journal()).toEqual([])
    expect(world.points).not.toContain('stage:before')
  })

  it('surfaces the too-large message from the first journal write, with nothing fenced', async () => {
    world.exportOverride = (exported, call) => {
      if (call !== 2) {
        return exported
      }
      const { manifestSha256: _signed, ...unsigned } = exported.manifest
      const grown = {
        ...unsigned,
        payload: {
          ...unsigned.payload,
          repositories: unsigned.payload.repositories.map((repo) => ({
            ...repo,
            symlinkPaths: Array.from(
              { length: 845 },
              (_, i) => `/home/dev/app/${'x'.repeat(900)}${i}`
            )
          }))
        }
      }
      return {
        ...exported,
        manifest: { ...grown, manifestSha256: computeOrcadMigrationManifestSha256(grown) }
      }
    }
    const result = await moveProjectsToWslHost(world.deps, request)

    expect(result).toMatchObject({ outcome: 'refused', code: 'wsl_move_manifest_too_large' })
    expect(result.outcome === 'refused' && result.message).toMatch(/too large to move in one step/)
    expect(journal()).toEqual([])
  })

  it('refuses a second move of the same distro while one runs', async () => {
    let release: () => void = () => {}
    const sleep = world.deps.quiesce.sleepWorkspaces
    world.deps.quiesce.sleepWorkspaces = async (ids) => {
      await new Promise<void>((resolve) => (release = resolve))
      return sleep(ids)
    }
    const first = moveProjectsToWslHost(world.deps, request)
    await vi.waitFor(() => expect(world.progress.map((e) => e.step)).toContain('pausing-terminals'))
    expect(await moveProjectsToWslHost(world.deps, { distro: 'ubuntu' })).toEqual({
      outcome: 'refused',
      code: 'wsl_move_already_running'
    })
    world.deps.quiesce.sleepWorkspaces = sleep
    release()
    expect(await first).toMatchObject({ outcome: 'moved' })
  })

  it('refuses a move whose terminals are busy, and shows the blockers in the preview', async () => {
    world.gate = {
      panes: [
        {
          paneKey: WSL_MOVE_WORLD_PANE,
          foreground: 'process-running',
          agent: { state: 'working', resumable: true, ownsForeground: true },
          scrollbackBytes: 0
        }
      ],
      runningAutomationRunIds: ['run-1'],
      activeDispatchIds: []
    }
    const preview = await previewWslMove(world.deps, request)
    expect(preview).toMatchObject({
      outcome: 'ready',
      repoIds: ['repo-1'],
      blockers: [
        { kind: 'agent-working', ids: [WSL_MOVE_WORLD_PANE] },
        { kind: 'automation-running', ids: ['run-1'] }
      ]
    })
    expect(await moveProjectsToWslHost(world.deps, request)).toMatchObject({
      outcome: 'refused',
      code: 'wsl_move_terminals_blocked'
    })
    expect(world.slept).toEqual([])
    expect(journal()).toEqual([])
  })

  it('stops at a cancel before the commit and puts everything back', async () => {
    const stage = world.deps.connectHost
    world.deps.connectHost = async (distro) => {
      const host = await stage(distro)
      if (!host) {
        return host
      }
      const original = host.catalog.stage
      return {
        ...host,
        catalog: {
          ...host.catalog,
          stage: async (manifest) => {
            cancelWslMove('Ubuntu')
            return original(manifest)
          }
        }
      }
    }
    expect(await moveProjectsToWslHost(world.deps, request)).toEqual({
      outcome: 'refused',
      code: 'wsl_move_cancelled'
    })
    expect(journal()).toEqual([])
    expect([...world.catalog.values()]).toEqual([])
  })

  it('is unreachable with the internal WSL hosts gate closed', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    const connectHost = vi.spyOn(world.deps, 'connectHost')
    expect(await previewWslMove(world.deps, request)).toEqual({
      outcome: 'refused',
      code: 'wsl_move_unavailable'
    })
    expect(await moveProjectsToWslHost(world.deps, request)).toEqual({
      outcome: 'refused',
      code: 'wsl_move_unavailable'
    })
    expect(connectHost).not.toHaveBeenCalled()
    expect(world.slept).toEqual([])
  })
  it('turns the moved automations back on on the host after commit, ledgered', async () => {
    const enable = vi.fn(async () => {})
    registerWslMoveHostAutomationsStore({ enable })
    world.exportOverride = (exported) => ({ ...exported, automationsToReenable: ['auto-1'] })
    expect(await moveProjectsToWslHost(world.deps, request)).toMatchObject({
      outcome: 'moved',
      phase: 'client-rewritten'
    })
    expect(enable).toHaveBeenCalledWith('wsl:Ubuntu', [{ id: 'auto-1', updatedAt: null }])
    expect(journal()[0]).toMatchObject({
      automationsToReenable: ['auto-1'],
      rewrittenStores: expect.arrayContaining([WSL_MOVE_HOST_AUTOMATIONS_STORE_ID])
    })
  })

  it.each([
    ['refuses', false],
    ['applies the change but loses the reply', true]
  ])(
    'never leaves automations silently off when the host %s: names them, then retries',
    async (_label, landsAnyway) => {
      const enabledOnHost = new Set<string>()
      let hostAnswers = false
      const enable = vi.fn(async (_env: string, rows: readonly WslMoveMovedAutomation[]) => {
        if (!hostAnswers) {
          if (landsAnyway) {
            rows.forEach((row) => enabledOnHost.add(row.id))
          }
          throw new Error('host unreachable')
        }
        rows.forEach((row) => enabledOnHost.add(row.id))
      })
      registerWslMoveHostAutomationsStore({ enable })
      world.exportOverride = (exported) => ({ ...exported, automationsToReenable: ['auto-1'] })

      const result = await moveProjectsToWslHost(world.deps, request)
      expect(result).toMatchObject({
        outcome: 'moved',
        phase: 'destination-committed',
        automationsPending: ['auto-1']
      })
      expect(listUnfinishedWslMoves(userDataPath)).toEqual([
        { migrationId: journal()[0].migrationId, distro: 'Ubuntu', automationsPending: ['auto-1'] }
      ])

      // Restart: recovery leaves a committed move alone; the startup pass retries from the journal.
      hostAnswers = true
      await recoverInterruptedWslMoves(userDataPath)
      await runWslMoveDesktopRewritePass({ userDataPath, warn: () => {} })
      expect(enabledOnHost).toEqual(new Set(['auto-1']))
      expect(journal()[0].phase).toBe('client-rewritten')
      expect(listUnfinishedWslMoves(userDataPath)).toEqual([])
    }
  )

  it('retries the host step in the same run, backing off, until it lands', async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      registerWslMoveHostAutomationsStore({
        enable: async () => {
          attempts += 1
          if (attempts < 3) {
            throw new Error('host unreachable')
          }
        }
      })
      world.exportOverride = (exported) => ({ ...exported, automationsToReenable: ['auto-1'] })
      expect(await moveProjectsToWslHost(world.deps, request)).toMatchObject({
        automationsPending: ['auto-1']
      })
      scheduleWslMoveRewriteRetry(userDataPath, [10, 20])
      await vi.advanceTimersByTimeAsync(10)
      expect(attempts).toBe(2)
      expect(journal()[0].phase).toBe('destination-committed')
      await vi.advanceTimersByTimeAsync(20)
      expect(attempts).toBe(3)
      expect(journal()[0].phase).toBe('client-rewritten')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(attempts).toBe(3)
    } finally {
      cancelWslMoveRewriteRetryForTests()
      vi.useRealTimers()
    }
  })

  it('asks for a new plan when a planned project is gone by the time it is paused', async () => {
    world.exportOverride = (exported, call) => {
      if (call === 2) {
        throw new WslMoveScopeChangedError(['repo-1'])
      }
      return exported
    }
    expect(await moveProjectsToWslHost(world.deps, request)).toEqual({
      outcome: 'refused',
      code: 'wsl_move_scope_changed'
    })
    expect(journal()).toEqual([])
  })
  describe('the unfenced first Sleep', () => {
    const busy = {
      panes: [
        {
          paneKey: WSL_MOVE_WORLD_PANE,
          foreground: 'process-running' as const,
          scrollbackBytes: 0
        }
      ],
      runningAutomationRunIds: [],
      activeDispatchIds: []
    }

    it('gates again right before it, and sleeps nothing that turned busy', async () => {
      let calls = 0
      world.deps.gateInputs = async () => ((calls += 1) === 2 ? busy : world.gate)
      expect(await moveProjectsToWslHost(world.deps, request)).toMatchObject({
        outcome: 'refused',
        code: 'wsl_move_terminals_blocked'
      })
      expect(world.slept).toEqual([])
      expect(journal()).toEqual([])
    })

    it('refuses when a terminal opened while the gate ran, rather than sleep it unrecorded', async () => {
      let calls = 0
      world.deps.listPanes = () =>
        (calls += 1) === 1
          ? []
          : [{ paneKey: WSL_MOVE_WORLD_PANE, sessionId: 'late', wslDistro: null }]
      expect(await moveProjectsToWslHost(world.deps, request)).toEqual({
        outcome: 'refused',
        code: 'wsl_move_pause_failed',
        detail: 'terminals-changed'
      })
      expect(world.slept).toEqual([])
    })

    it('removes the record when the quiesce refuses before its fence', async () => {
      let calls = 0
      world.deps.gateInputs = async () => ((calls += 1) === 3 ? busy : world.gate)
      expect(await moveProjectsToWslHost(world.deps, request)).toMatchObject({
        code: 'wsl_move_terminals_blocked'
      })
      expect(journal()).toEqual([])
    })
  })

  it.each<[string, (exported: WslMoveManifestExport) => WslMoveManifestExport]>([
    ['state it would leave behind', (exported) => ({ ...exported, blockers: ['1 saved tab'] })],
    ['an automation switched on', (exported) => ({ ...exported, automationsToReenable: ['a'] })]
  ])('resets when, under the fence, the project gained %s', async (_label, change) => {
    world.exportOverride = (exported, call) => (call === 3 ? change(exported) : exported)
    expect(await moveProjectsToWslHost(world.deps, request)).toEqual({
      outcome: 'refused',
      code: 'wsl_move_scope_changed'
    })
    expect(journal()).toEqual([])
  })

  it('no longer cancels once the commit was requested', async () => {
    const connect = world.deps.connectHost
    let cancelled: boolean | null = null
    world.deps.connectHost = async (distro) => {
      const host = await connect(distro)
      return host
        ? {
            ...host,
            commitWithBlobs: (manifest, blobs) => {
              cancelled = cancelWslMove('Ubuntu')
              return host.commitWithBlobs(manifest, blobs)
            }
          }
        : host
    }
    expect(await moveProjectsToWslHost(world.deps, request)).toMatchObject({ outcome: 'moved' })
    expect(cancelled).toBe(false)
  })

  describe('an earlier move an interruption left short of commit', () => {
    const seedStuck = () => {
      const stuck = wslMoveCutoverFixture('stuck', 'blobs-transferred', {}, { repoIds: ['repo-9'] })
      seedWslMoveCutover(userDataPath, stuck)
      return stuck
    }

    it('is reset through the host first, then the new move runs', async () => {
      world.catalog.set(seedStuck().migrationId, 'staged')
      expect(await moveProjectsToWslHost(world.deps, request)).toMatchObject({ outcome: 'moved' })
      expect(journal().map((cutover) => cutover.migrationId)).not.toContain('stuck')
      expect(world.catalog.has('stuck')).toBe(false)
    })

    it('goes forward when the host committed it, and the new move waits for it to finish', async () => {
      world.catalog.set(seedStuck().migrationId, 'committed')
      expect(await moveProjectsToWslHost(world.deps, request)).toEqual({
        outcome: 'refused',
        code: 'wsl_move_finished_earlier_move'
      })
      expect(journal().find((cutover) => cutover.migrationId === 'stuck')?.phase).toBe(
        'client-rewritten'
      )
      // Nothing of the new move started under the window that must reload first.
      expect(world.slept).toEqual([])
    })

    it('keeps the fence and refuses while the host cannot say', async () => {
      seedStuck()
      world.deps.connectHost = async () => {
        const host = await createWslMoveWorld(userDataPath).deps.connectHost('Ubuntu')
        if (!host) {
          return host
        }
        return {
          ...host,
          catalog: {
            ...host.catalog,
            readState: async () => {
              throw new Error('socket closed')
            },
            abortByReference: async () => {
              throw new Error('socket closed')
            }
          }
        }
      }
      expect(await moveProjectsToWslHost(world.deps, request)).toMatchObject({
        outcome: 'refused',
        code: 'wsl_move_already_in_flight'
      })
      expect(journal().map((cutover) => cutover.phase)).toEqual(['blobs-transferred'])
    })
  })
})
