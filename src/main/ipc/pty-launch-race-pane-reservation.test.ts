import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from '../runtime/worktree-terminals-sleeping-error'
import {
  LAUNCH_RACE_LANES,
  createLaunchRaceRuntime,
  flushMacrotasks,
  gatedClaudeAuth,
  installLaunchRaceProvider,
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

// Pins main's current launch behaviour as the baseline the spawn-lane merge must keep.
describe('launch race parity: who owns the pane, both spawn lanes', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  // Row 2: IPC joins a spawn holding the pane as a reattach and checks nothing
  // (ipc/spawn-begin.ts:114-119); the runtime lane refuses a winner it cannot verify as the pane
  // owner (runtime/spawn-options.ts:252-273). Here the winner leaves no owner the runtime can see.
  const JOINED_UNVERIFIED_WINNER: Record<LaunchRaceLane, 'reattach' | 'refused'> = {
    ipc: 'reattach',
    runtime: 'refused'
  }
  it.each(LAUNCH_RACE_LANES)(
    '%s lane: a spawn arriving while a window spawn is starting the pane joins it',
    async (lane) => {
      const pane = launchRacePane(`race-join-${lane}`, '72727272-7272-4272-8272-727272727272')
      let finishSpawn!: () => void
      const provider = installLaunchRaceProvider(
        () =>
          new Promise((resolve) => {
            finishSpawn = () => resolve({ id: 'pty-join-winner' })
          })
      )
      const lanes = registerLaunchRaceLanes({
        handlers,
        mainWindow,
        runtime: createLaunchRaceRuntime()
      })

      const winner = lanes.spawn.ipc(pane.args)
      await vi.waitFor(() => expect(provider.spawn).toHaveBeenCalledOnce())
      const joiner = lanes.spawn[lane](pane.args)
      await flushMacrotasks()
      finishSpawn()

      await expect(winner).resolves.toMatchObject({ id: 'pty-join-winner' })
      await (JOINED_UNVERIFIED_WINNER[lane] === 'reattach'
        ? expect(joiner).resolves.toMatchObject({ id: 'pty-join-winner', isReattach: true })
        : expect(joiner).rejects.toThrow('terminal_pane_owner_unknown'))
      expect(provider.spawn).toHaveBeenCalledOnce()
    }
  )

  // Row 4: an unowned runtime spawn holds the pane from before its preflight (runtime/spawn.ts:78-81).
  it('a window mount arriving during an unowned runtime spawn preflight joins that spawn', async () => {
    const pane = launchRacePane('race-runtime-early-hold', '75757575-7575-4575-8575-757575757575')
    const provider = installLaunchRaceProvider(async () => ({ id: 'pty-early-hold' }))
    const auth = gatedClaudeAuth()
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime: createLaunchRaceRuntime(),
      prepareClaudeAuth: auth.prepareClaudeAuth
    })

    const held = lanes.spawn.runtime({ ...pane.args, command: 'claude' })
    await vi.waitFor(() => expect(auth.prepareClaudeAuth).toHaveBeenCalledOnce())
    const mount = lanes.spawn.ipc(pane.args)
    await flushMacrotasks()
    auth.release()

    await expect(held).resolves.toMatchObject({ id: 'pty-early-hold' })
    await expect(mount).resolves.toMatchObject({ id: 'pty-early-hold', isReattach: true })
    expect(provider.spawn).toHaveBeenCalledOnce()
  })

  // Row 4: with an owner, the runtime lane reserves only after preflight (runtime/spawn.ts:78).
  it('a runtime spawn for an owned pane does not hold the pane through its preflight', async () => {
    const pane = launchRacePane('race-runtime-owned', '76767676-7676-4676-8676-767676767676')
    installLaunchRaceProvider(async (options) =>
      options.attachOnly
        ? { id: 'pty-existing-owner', isReattach: true }
        : { id: 'pty-unexpected-fresh' }
    )
    const runtime = createLaunchRaceRuntime({
      resolveTerminalPane: vi.fn(() => ({
        handle: 'term-existing-owner',
        tabId: pane.tabId,
        leafId: pane.leafId,
        ptyId: 'pty-existing-owner',
        worktreeId: pane.worktreeId
      }))
    })
    const auth = gatedClaudeAuth()
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime,
      prepareClaudeAuth: auth.prepareClaudeAuth
    })

    const held = lanes.spawn.runtime({ ...pane.args, command: 'claude' })
    await vi.waitFor(() => expect(auth.prepareClaudeAuth).toHaveBeenCalledOnce())
    const mount = lanes.spawn.ipc(pane.args)
    const settledFirst = await Promise.race([
      mount.then(() => 'mount'),
      flushMacrotasks(50).then(() => 'still waiting')
    ])

    expect(settledFirst).toBe('mount')
    await expect(mount).resolves.toMatchObject({ id: 'pty-existing-owner', isReattach: true })
    auth.release()
    await expect(held).resolves.toMatchObject({ id: 'pty-existing-owner' })
  })

  // Row 3: the runtime lane joins with joinPaneSpawn (runtime/spawn-options.ts:257), so a slept
  // refusal frees the pane; IPC awaits the other spawn's result as is (ipc/spawn-begin.ts:117-118).
  // The IPC cell is a code-level drift no producer reaches today: see the next test.
  const JOINED_SLEPT_REFUSAL: Record<LaunchRaceLane, 'refused' | 'spawns itself'> = {
    ipc: 'refused',
    runtime: 'spawns itself'
  }
  it.each(LAUNCH_RACE_LANES)(
    '%s lane: a spawn joining an automatic spawn refused for a slept worktree',
    async (lane) => {
      const pane = launchRacePane(`race-slept-${lane}`, '73737373-7373-4373-8373-737373737373')
      let refused = false
      const spawnedAfterRefusal: boolean[] = []
      const provider = installLaunchRaceProvider(async () => {
        spawnedAfterRefusal.push(refused)
        return { id: 'pty-user-wake' }
      })
      const lock = sleptWorktreeLock()
      const runtime = createLaunchRaceRuntime({
        acquireWorktreeTerminalSpawn: lock.acquireWorktreeTerminalSpawn
      })
      const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

      const automatic = lanes.spawn.runtime({ ...pane.args, refuseSleptWorktree: true })
      await vi.waitFor(() => expect(lock.acquireWorktreeTerminalSpawn).toHaveBeenCalledOnce())
      const joiner = lanes.spawn[lane](pane.args)
      await flushMacrotasks()
      refused = true
      lock.refuse()

      await expect(automatic).rejects.toThrow(WORKTREE_TERMINALS_SLEEPING_ERROR)
      if (JOINED_SLEPT_REFUSAL[lane] === 'refused') {
        await expect(joiner).rejects.toThrow(WORKTREE_TERMINALS_SLEEPING_ERROR)
        expect(provider.spawn).not.toHaveBeenCalled()
      } else {
        await expect(joiner).resolves.toMatchObject({ id: 'pty-user-wake' })
        // Spawning only after the refusal proves it waited on the automatic spawn first.
        expect(spawnedAfterRefusal).toEqual([true])
      }
    }
  )

  // createTerminal holds a create claim across its spawn (orca-runtime-create-terminal.ts:45-50,
  // 177-179) and the window waits on it (ipc/spawn-begin.ts:108-113), so the window wakes the pane.
  it('a window mount racing a claimed automatic spawn refused for a slept worktree spawns itself', async () => {
    const pane = launchRacePane('race-slept-claimed', '77777777-7777-4777-8777-777777777777')
    const provider = installLaunchRaceProvider(async () => ({ id: 'pty-user-mount' }))
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
    expect(provider.spawn).toHaveBeenCalledOnce()
  })

  // Row 3: the host's own adoption joins with joinPaneSpawn (pane/adopt-stable.ts:33).
  it('host adoption of a pane whose automatic spawn was refused for a slept worktree finds nothing to adopt', async () => {
    const pane = launchRacePane('race-slept-adopt', '78787878-7878-4878-8878-787878787878')
    installLaunchRaceProvider(async () => ({ id: 'pty-must-not-spawn' }))
    const lock = sleptWorktreeLock()
    const runtime = createLaunchRaceRuntime({
      acquireWorktreeTerminalSpawn: lock.acquireWorktreeTerminalSpawn
    })
    const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

    const automatic = lanes.spawn.runtime({ ...pane.args, refuseSleptWorktree: true })
    await vi.waitFor(() => expect(lock.acquireWorktreeTerminalSpawn).toHaveBeenCalledOnce())
    const adoption = lanes.controller.adoptStablePane({
      cols: 80,
      rows: 24,
      cwd: pane.args.cwd,
      connectionId: null,
      worktreeId: pane.worktreeId,
      tabId: pane.tabId,
      leafId: pane.leafId
    })
    lock.refuse()

    await expect(automatic).rejects.toThrow(WORKTREE_TERMINALS_SLEEPING_ERROR)
    await expect(adoption).resolves.toBeNull()
  })
})
