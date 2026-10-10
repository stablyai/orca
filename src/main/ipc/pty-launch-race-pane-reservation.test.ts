import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { paneSpawnReservationsByOwnerKey } from './pty/pane/spawn-reservation'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from '../runtime/worktree-terminals-sleeping-error'
import {
  createLaunchRaceRuntime,
  gatedClaudeAuth,
  installLaunchRaceProvider,
  launchRacePane,
  registerLaunchRaceLanes,
  watchPaneSpawnJoin
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

const flushMacrotasks = async (rounds = 5): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function sleptWorktreeAcquire() {
  let refuse!: () => void
  const refusal = new Promise<void>((resolve) => {
    refuse = resolve
  })
  const acquireWorktreeTerminalSpawn = vi.fn(
    async (_worktreeId?: string, opts?: { refuseSleptWorktree?: boolean }) => {
      if (opts?.refuseSleptWorktree) {
        await refusal
        throw new Error(WORKTREE_TERMINALS_SLEEPING_ERROR)
      }
      return () => {}
    }
  )
  return { acquireWorktreeTerminalSpawn, refuse }
}

// Pins main's current launch behaviour as the convergence parity baseline (pane reservation races).
describe('launch race parity: pane reservation, both spawn lanes', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it('IPC lane waits for a pending runtime create before its own preflight (ipc/spawn-begin.ts:108-113)', async () => {
    const pane = launchRacePane('race-pending-create', '71717171-7171-4171-8171-717171717171')
    const provider = installLaunchRaceProvider(async () => ({ id: 'pty-after-create' }))
    const runtime = createLaunchRaceRuntime()
    const auth = gatedClaudeAuth()
    auth.release()
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime,
      prepareClaudeAuth: auth.prepareClaudeAuth
    })
    const releaseCreate = lanes.controller.claimStablePaneCreate({
      worktreeId: pane.worktreeId,
      connectionId: null,
      tabId: pane.tabId,
      leafId: pane.leafId
    })

    const mounted = lanes.spawnThroughIpc({ ...pane.args, command: 'claude' })
    await flushMacrotasks()
    expect(auth.prepareClaudeAuth).not.toHaveBeenCalled()
    expect(provider.spawn).not.toHaveBeenCalled()

    releaseCreate()
    await expect(mounted).resolves.toMatchObject({ id: 'pty-after-create' })
    expect(auth.prepareClaudeAuth).toHaveBeenCalledOnce()
  })

  it('IPC lane joins a spawn already holding the pane as a reattach, skipping its own preflight (ipc/spawn-begin.ts:114-119)', async () => {
    const pane = launchRacePane('race-join-at-begin', '72727272-7272-4272-8272-727272727272')
    let finishSpawn!: () => void
    const provider = installLaunchRaceProvider(
      () =>
        new Promise((resolve) => {
          finishSpawn = () => resolve({ id: 'pty-join-winner' })
        })
    )
    const runtime = createLaunchRaceRuntime()
    const auth = gatedClaudeAuth()
    auth.release()
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime,
      prepareClaudeAuth: auth.prepareClaudeAuth
    })

    const winner = lanes.controller.spawn({ ...pane.args, command: 'printf runtime' })
    await vi.waitFor(() => expect(provider.spawn).toHaveBeenCalledOnce())
    const joiner = lanes.spawnThroughIpc({ ...pane.args, command: 'claude' })
    await flushMacrotasks()
    finishSpawn()

    await expect(winner).resolves.toMatchObject({ id: 'pty-join-winner' })
    await expect(joiner).resolves.toMatchObject({ id: 'pty-join-winner', isReattach: true })
    expect(auth.prepareClaudeAuth).not.toHaveBeenCalled()
    expect(provider.spawn).toHaveBeenCalledOnce()
  })

  // Lane drift: the IPC lane awaits the raw reservation, not joinPaneSpawn (contrast the runtime case below).
  it('IPC lane joining an automatic spawn refused for a slept worktree fails with that refusal (ipc/spawn-begin.ts:117-118)', async () => {
    const pane = launchRacePane('race-slept-ipc-join', '73737373-7373-4373-8373-737373737373')
    const provider = installLaunchRaceProvider(async () => ({ id: 'pty-must-not-spawn' }))
    const sleep = sleptWorktreeAcquire()
    const runtime = createLaunchRaceRuntime({
      acquireWorktreeTerminalSpawn: sleep.acquireWorktreeTerminalSpawn
    })
    const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

    const automatic = lanes.controller.spawn({ ...pane.args, refuseSleptWorktree: true })
    await vi.waitFor(() => expect(sleep.acquireWorktreeTerminalSpawn).toHaveBeenCalledOnce())
    const hasJoined = watchPaneSpawnJoin(pane.ownerKey)
    const userMount = lanes.spawnThroughIpc(pane.args)
    await vi.waitFor(() => expect(hasJoined()).toBe(true))
    sleep.refuse()

    await expect(automatic).rejects.toThrow(WORKTREE_TERMINALS_SLEEPING_ERROR)
    await expect(userMount).rejects.toThrow(WORKTREE_TERMINALS_SLEEPING_ERROR)
    expect(provider.spawn).not.toHaveBeenCalled()
  })

  it('runtime lane joining an automatic spawn refused for a slept worktree spawns the pane itself (runtime/spawn-options.ts:257)', async () => {
    const pane = launchRacePane('race-slept-runtime-join', '74747474-7474-4474-8474-747474747474')
    const provider = installLaunchRaceProvider(async () => ({ id: 'pty-user-wake' }))
    const sleep = sleptWorktreeAcquire()
    const runtime = createLaunchRaceRuntime({
      acquireWorktreeTerminalSpawn: sleep.acquireWorktreeTerminalSpawn
    })
    const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

    const automatic = lanes.controller.spawn({ ...pane.args, refuseSleptWorktree: true })
    await vi.waitFor(() => expect(sleep.acquireWorktreeTerminalSpawn).toHaveBeenCalledOnce())
    const hasJoined = watchPaneSpawnJoin(pane.ownerKey)
    const userWake = lanes.controller.spawn({ ...pane.args, command: 'user-wake' })
    await vi.waitFor(() => expect(hasJoined()).toBe(true))
    sleep.refuse()

    await expect(automatic).rejects.toThrow(WORKTREE_TERMINALS_SLEEPING_ERROR)
    await expect(userWake).resolves.toMatchObject({ id: 'pty-user-wake' })
    expect(provider.spawn).toHaveBeenCalledOnce()
    expect(provider.spawn.mock.calls[0]?.[0]).toMatchObject({ command: 'user-wake' })
  })

  it('runtime lane reserves an unowned, unreserved pane before its preflight (runtime/spawn.ts:78-81)', async () => {
    const pane = launchRacePane(
      'race-runtime-early-reserve',
      '75757575-7575-4575-8575-757575757575'
    )
    installLaunchRaceProvider(async () => ({ id: 'pty-early-reserve' }))
    const runtime = createLaunchRaceRuntime()
    const auth = gatedClaudeAuth()
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime,
      prepareClaudeAuth: auth.prepareClaudeAuth
    })

    const spawn = lanes.controller.spawn({ ...pane.args, command: 'claude' })
    await vi.waitFor(() => expect(auth.prepareClaudeAuth).toHaveBeenCalledOnce())
    expect(paneSpawnReservationsByOwnerKey.has(pane.ownerKey)).toBe(true)

    auth.release()
    await expect(spawn).resolves.toMatchObject({ id: 'pty-early-reserve' })
    expect(paneSpawnReservationsByOwnerKey.has(pane.ownerKey)).toBe(false)
  })

  it('runtime lane does not reserve early for a pane that already has an owner (runtime/spawn.ts:78)', async () => {
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

    const spawn = lanes.controller.spawn({ ...pane.args, command: 'claude' })
    await vi.waitFor(() => expect(auth.prepareClaudeAuth).toHaveBeenCalledOnce())
    expect(paneSpawnReservationsByOwnerKey.has(pane.ownerKey)).toBe(false)

    auth.release()
    await expect(spawn).resolves.toMatchObject({ id: 'pty-existing-owner' })
  })
})
