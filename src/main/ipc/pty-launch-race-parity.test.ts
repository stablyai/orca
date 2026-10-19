import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type * as JcodeRuntimeDir from '../../shared/jcode-runtime-dir'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { getHiddenRendererPtyIds, isHiddenRendererPty } from './pty-hidden-delivery-gate'
import { ptySizes } from './pty/delivery/visibility-state'
import { clearProviderPtyState } from './pty/provider/state-cleanup'
import * as paneSpawnReservations from './pty/pane/spawn-reservation'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from '../runtime/worktree-terminals-sleeping-error'
import {
  LAUNCH_RACE_LANES,
  createLaunchRaceRuntime,
  gatedClaudeAuth,
  launchRacePane,
  registerLaunchRaceLanes,
  sleptWorktreeLock,
  type LaunchRaceLane
} from './pty-launch-race-test-fixture'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)
// Why: the host lane's real mkdir is thread-pool I/O, so a joiner could miss flushMacrotasks' turns under load.
vi.mock('../../shared/jcode-runtime-dir', async (importOriginal) => {
  const actual = await importOriginal<typeof JcodeRuntimeDir>()
  return {
    ...actual,
    ensureJcodeRuntimeDir: async (paneKey: string) => actual.buildJcodeRuntimeDirEnv(paneKey)
  }
})

const mintedFor = (worktreeId: string): string[] =>
  getHiddenRendererPtyIds().filter((id) => id.startsWith(`${worktreeId}@@`))

// Pins main's window lane (pty:spawn) and host lane (runtime controller) as the spawn-lane merge's baseline.
describe('launch race parity, both spawn lanes', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()

  describe('who owns the pane', () => {
    // C6 picks one: the window joins before its setup and checks nothing; the host joins after and verifies.
    const JOINED_UNVERIFIED_WINNER: Record<LaunchRaceLane, 'reattach' | 'refused'> = {
      ipc: 'reattach',
      runtime: 'refused'
    }
    const JOINER_PREPARES_ITS_OWN_LAUNCH: Record<LaunchRaceLane, number> = { ipc: 0, runtime: 1 }
    it.each(LAUNCH_RACE_LANES)(
      '%s lane: a spawn arriving while a window spawn is starting the pane joins it',
      async (lane) => {
        const pane = launchRacePane(`race-join-${lane}`, '72727272-7272-4272-8272-727272727272')
        let finishSpawn!: () => void
        const spawn = vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finishSpawn = () => resolve({ id: 'pty-join-winner' })
              })
          )
          // A joiner that missed the join fails here instead of hanging on a spawn nobody finishes.
          .mockRejectedValue(new Error('joiner_spawned_its_own_pty'))
        installDaemonTestProvider({ spawn })
        const auth = gatedClaudeAuth()
        auth.release()
        const lanes = registerLaunchRaceLanes({
          handlers,
          mainWindow,
          runtime: createLaunchRaceRuntime(),
          prepareClaudeAuth: auth.prepareClaudeAuth
        })

        const winner = lanes.spawn.ipc(pane.args)
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
        const joinPaneSpawn = vi.spyOn(paneSpawnReservations, 'joinPaneSpawn')
        onTestFinished(() => joinPaneSpawn.mockRestore())
        const joiner = lanes.spawn[lane]({ ...pane.args, command: 'claude' })
        if (lane === 'runtime') {
          // Runtime preflight does filesystem work before it can join the reserved pane.
          await vi.waitFor(() => expect(joinPaneSpawn).toHaveBeenCalledOnce())
        }
        finishSpawn()

        await expect(winner).resolves.toMatchObject({ id: 'pty-join-winner' })
        await (JOINED_UNVERIFIED_WINNER[lane] === 'reattach'
          ? expect(joiner).resolves.toMatchObject({ id: 'pty-join-winner', isReattach: true })
          : expect(joiner).rejects.toThrow('terminal_pane_owner_unknown'))
        expect(spawn).toHaveBeenCalledOnce()
        expect(auth.prepareClaudeAuth).toHaveBeenCalledTimes(JOINER_PREPARES_ITS_OWN_LAUNCH[lane])
      }
    )

    // C6 spreads joinPaneSpawn to both lanes: a slept-worktree refusal means "nothing to join".
    it('runtime lane: a spawn joining an automatic spawn refused for a slept worktree spawns itself', async () => {
      const pane = launchRacePane('race-slept-runtime', '73737373-7373-4373-8373-737373737373')
      let refused = false
      const spawnedAfterRefusal: boolean[] = []
      installDaemonTestProvider({
        spawn: vi.fn(async () => {
          spawnedAfterRefusal.push(refused)
          return { id: 'pty-user-wake' }
        })
      })
      const lock = sleptWorktreeLock()
      const runtime = createLaunchRaceRuntime({
        acquireWorktreeTerminalSpawn: lock.acquireWorktreeTerminalSpawn
      })
      const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

      const automatic = lanes.spawn.runtime({ ...pane.args, refuseSleptWorktree: true })
      await vi.waitFor(() => expect(lock.acquireWorktreeTerminalSpawn).toHaveBeenCalledOnce())
      const joinPaneSpawn = vi.spyOn(paneSpawnReservations, 'joinPaneSpawn')
      onTestFinished(() => joinPaneSpawn.mockRestore())
      const joiner = lanes.spawn.runtime(pane.args)
      await vi.waitFor(() => expect(joinPaneSpawn).toHaveBeenCalledOnce())
      refused = true
      lock.refuse()

      await expect(automatic).rejects.toThrow(WORKTREE_TERMINALS_SLEEPING_ERROR)
      await expect(joiner).resolves.toMatchObject({ id: 'pty-user-wake' })
      // Spawning only after the refusal proves it waited on the automatic spawn first.
      expect(spawnedAfterRefusal).toEqual([true])
    })

    // C2 and C6 rely on this: createTerminal's claim makes the window wait out the refusal, then wake it.
    it('a window mount racing a claimed automatic spawn refused for a slept worktree spawns itself', async () => {
      const pane = launchRacePane('race-slept-claimed', '77777777-7777-4777-8777-777777777777')
      const spawn = vi.fn(async () => ({ id: 'pty-user-mount' }))
      installDaemonTestProvider({ spawn })
      const lock = sleptWorktreeLock()
      const runtime = createLaunchRaceRuntime({
        acquireWorktreeTerminalSpawn: lock.acquireWorktreeTerminalSpawn
      })
      const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })
      const release = lanes.controller.claimStablePaneCreate({
        worktreeId: pane.worktreeId,
        connectionId: null,
        tabId: pane.tabId,
        leafId: pane.leafId
      })
      const automatic = lanes.spawn
        .runtime({ ...pane.args, refuseSleptWorktree: true })
        .finally(release)
      await vi.waitFor(() => expect(lock.acquireWorktreeTerminalSpawn).toHaveBeenCalledOnce())
      const mount = lanes.spawn.ipc(pane.args)
      lock.refuse()

      await expect(automatic).rejects.toThrow(WORKTREE_TERMINALS_SLEEPING_ERROR)
      await expect(mount).resolves.toMatchObject({ id: 'pty-user-mount' })
      expect(spawn).toHaveBeenCalledOnce()
    })
  })

  describe('cleanup when a start fails', () => {
    // C5d and C6 pick one: the host overwrites a cached size while building, then restores it.
    const CACHED_SIZE_WHILE_BUILDING: Record<LaunchRaceLane, object> = {
      ipc: { cols: 100, rows: 30 },
      runtime: { cols: 80, rows: 24 }
    }
    describe.each(LAUNCH_RACE_LANES)('%s lane: options build fails', (lane: LaunchRaceLane) => {
      it.each([
        { label: 'no size before', cached: undefined },
        { label: 'a size before', cached: { cols: 100, rows: 30 } }
      ])('the session keeps $label', async ({ label, cached }) => {
        const sessionId = `race-size-${lane}-${label.replaceAll(' ', '-')}`
        let sizeWhileBuilding: unknown
        const recordSize = (): void => {
          sizeWhileBuilding = ptySizes.get(sessionId)
        }
        const spawn = vi.fn()
        installDaemonTestProvider({
          spawn,
          supportsAgentSessionCreateOperations: vi.fn(async () => {
            recordSize()
            return false
          })
        })
        const runtime = createLaunchRaceRuntime({
          acquireWorktreeTerminalSpawn: vi.fn(async () => {
            recordSize()
            throw new Error('execution_owner_unavailable')
          })
        })
        const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })
        onTestFinished(() => {
          ptySizes.delete(sessionId)
        })
        if (cached) {
          ptySizes.set(sessionId, cached)
        }
        const failingArgs =
          lane === 'ipc'
            ? {}
            : { isNewSession: true, agentSessionCreateOperationId: `op-${sessionId}` }

        await expect(
          lanes.spawn[lane]({
            cols: 80,
            rows: 24,
            cwd: '/tmp/race-size',
            worktreeId: 'repo-1::/tmp/race-size',
            sessionId,
            ...failingArgs
          })
        ).rejects.toThrow('execution_owner_unavailable')

        expect(sizeWhileBuilding).toEqual(
          cached ? CACHED_SIZE_WHILE_BUILDING[lane] : { cols: 80, rows: 24 }
        )
        expect(ptySizes.get(sessionId)).toEqual(cached)
        expect(spawn).not.toHaveBeenCalled()
      })
    })

    // C5a and C5e rely on this: a throw after the provider spawn rolls the pre-spawn mark back.
    it.each(LAUNCH_RACE_LANES)(
      '%s lane: a throw after the provider spawn rolls the pre-spawn hidden mark back',
      async (lane) => {
        const worktreeId = `repo-1::/tmp/race-hidden-rollback-${lane}`
        let markedWhileSpawning: string[] = []
        installDaemonTestProvider({
          spawn: vi.fn(async (options: { sessionId?: string }) => {
            markedWhileSpawning = mintedFor(worktreeId)
            return { id: String(options.sessionId) }
          })
        })
        const runtime = createLaunchRaceRuntime({
          registerPty: vi.fn(() => {
            throw new Error('register failed')
          })
        })
        const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

        await expect(
          lanes.spawn[lane]({ cols: 80, rows: 24, cwd: '/tmp', worktreeId, initiallyHidden: true })
        ).rejects.toThrow('register failed')

        expect(markedWhileSpawning).toHaveLength(1)
        expect(mintedFor(worktreeId)).toEqual([])
      }
    )

    // C5e relies on this: the hidden mark follows the id the provider returned.
    it.each(LAUNCH_RACE_LANES)(
      '%s lane: the hidden mark moves to the id the provider returned',
      async (lane) => {
        installDaemonTestProvider({ spawn: vi.fn(async () => ({ id: `pty-renamed-${lane}` })) })
        const lanes = registerLaunchRaceLanes({
          handlers,
          mainWindow,
          runtime: createLaunchRaceRuntime()
        })

        await lanes.spawn[lane]({ cols: 80, rows: 24, cwd: '/tmp', initiallyHidden: true })

        expect(getHiddenRendererPtyIds()).toEqual([`pty-renamed-${lane}`])
      }
    )

    // C5e and C6 change one cell: the window keeps the hidden mark on a reattach; the host skips it.
    const HIDDEN_REATTACH: Record<LaunchRaceLane, boolean> = { ipc: true, runtime: false }
    it.each(LAUNCH_RACE_LANES)('%s lane: a hidden-requested reattach', async (lane) => {
      const sessionId = `race-hidden-reattach-${lane}`
      installDaemonTestProvider({ spawn: vi.fn(async () => ({ id: sessionId, isReattach: true })) })
      const lanes = registerLaunchRaceLanes({
        handlers,
        mainWindow,
        runtime: createLaunchRaceRuntime()
      })

      await lanes.spawn[lane]({ cols: 80, rows: 24, cwd: '/tmp', sessionId, initiallyHidden: true })

      expect(isHiddenRendererPty(sessionId)).toBe(HIDDEN_REATTACH[lane])
    })
  })

  describe('saving and admitting the new process', () => {
    const forgetPtyAfterTest = (ptyId: string): void => {
      onTestFinished(() => clearProviderPtyState(ptyId))
    }

    // C2 and C5e rely on this: a failed save discards the PTY, reports "unknown" and cancels registration.
    const SAVE_BINDING_ARGS: Record<LaunchRaceLane, Record<string, unknown>> = {
      ipc: {},
      runtime: { persistHostSessionBinding: true }
    }
    it.each(LAUNCH_RACE_LANES)(
      '%s lane: a failed binding save discards the PTY and reports the outcome as unknown',
      async (lane) => {
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
        onTestFinished(() => errorLog.mockRestore())
        const pane = launchRacePane(
          `race-save-fail-${lane}`,
          '81818181-8181-4181-8181-818181818181'
        )
        const ptyId = `pty-save-fail-${lane}`
        const shutdown = vi.fn(async () => {})
        installDaemonTestProvider({
          spawn: vi.fn(async () => ({ id: ptyId, incarnationId: 'inc-1' })),
          shutdown
        })
        const runtime = createLaunchRaceRuntime()
        const store = {
          persistPtyBinding: vi.fn(async () => {
            throw new Error('disk full')
          })
        }
        const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime, store })
        forgetPtyAfterTest(ptyId)

        const spawn = lanes.spawn[lane]({ ...pane.args, ...SAVE_BINDING_ARGS[lane] })

        await expect(spawn).rejects.toThrow('ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED')
        await expect(spawn).rejects.toMatchObject({ agentSessionOperationOutcome: 'unknown' })
        expect(shutdown).toHaveBeenCalledWith(ptyId, {
          immediate: true,
          expectedIncarnationId: 'inc-1'
        })
        expect(runtime.cancelPendingPtyRegistration).toHaveBeenCalledWith(ptyId, 'inc-1')
      }
    )

    // C5e/C6: the pipeline returns an incarnation that exits mid-registration; the host adapter fails it.
    const EXITED_DURING_REGISTRATION: Record<LaunchRaceLane, 'resolves' | 'rejects'> = {
      ipc: 'resolves',
      runtime: 'rejects'
    }
    it.each(LAUNCH_RACE_LANES)(
      '%s lane: an incarnation that exits while it is registered',
      async (lane) => {
        const pane = launchRacePane(`race-exited-${lane}`, '83838383-8383-4383-8383-838383838383')
        const ptyId = `pty-exited-${lane}`
        installDaemonTestProvider({
          spawn: vi.fn(async () => ({ id: ptyId, incarnationId: 'inc-exited' }))
        })
        const runtime = createLaunchRaceRuntime({
          registerPty: vi.fn(() => {
            throw new Error('agent_session_exited_during_start')
          }),
          getPtyLivenessVerdict: vi.fn(() => ({ status: 'exited' }))
        })
        const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })
        forgetPtyAfterTest(ptyId)

        const spawn = lanes.spawn[lane](pane.args)

        await (EXITED_DURING_REGISTRATION[lane] === 'resolves'
          ? expect(spawn).resolves.toMatchObject({ id: ptyId, incarnationId: 'inc-exited' })
          : expect(spawn).rejects.toThrow('agent_session_exited_during_start'))
        expect(runtime.cancelPendingPtyRegistration).toHaveBeenCalledWith(ptyId, 'inc-exited')
        expect(runtime.noteTerminalSpawnCommit).not.toHaveBeenCalled()
        expect(runtime.reflowHeadlessTerminalToPtyGrid).not.toHaveBeenCalled()
      }
    )

    // C5e relies on this: the model is resized to the grid only after the process is registered.
    it.each(LAUNCH_RACE_LANES)(
      '%s lane: an admitted spawn resizes the model to its grid after registering it',
      async (lane) => {
        const pane = launchRacePane(`race-reflow-${lane}`, '85858585-8585-4585-8585-858585858585')
        const ptyId = `pty-reflow-${lane}`
        installDaemonTestProvider({ spawn: vi.fn(async () => ({ id: ptyId })) })
        const runtime = createLaunchRaceRuntime()
        const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })
        forgetPtyAfterTest(ptyId)

        await lanes.spawn[lane]({ ...pane.args, cols: 132, rows: 40 })

        expect(runtime.reflowHeadlessTerminalToPtyGrid).toHaveBeenCalledWith(ptyId, 132, 40)
        expect(runtime.registerPty.mock.invocationCallOrder[0]).toBeLessThan(
          runtime.reflowHeadlessTerminalToPtyGrid.mock.invocationCallOrder[0]!
        )
      }
    )
  })
})
