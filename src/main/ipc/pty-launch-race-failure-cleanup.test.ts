import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { getHiddenRendererPtyIds, isHiddenRendererPty } from './pty-hidden-delivery-gate'
import { ptySizes } from './pty/delivery/visibility-state'
import {
  createLaunchRaceRuntime,
  gatedClaudeAuth,
  installLaunchRaceProvider,
  registerLaunchRaceLanes
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

/** Starts degraded (fresh spawns routed locally) until the spawn path recovers daemon routing. */
function installDegradedRaceProvider(spawn: Parameters<typeof installLaunchRaceProvider>[0]) {
  const provider = installLaunchRaceProvider(spawn)
  let degraded = true
  const recoverFreshSpawnRouting = vi.fn(async () => {
    degraded = false
    return true
  })
  Object.defineProperties(provider, {
    routesFreshSpawnsToLocalProvider: {
      configurable: true,
      get: () => (degraded ? true : undefined)
    },
    recoverFreshSpawnRouting: { value: recoverFreshSpawnRouting }
  })
  return { provider, recoverFreshSpawnRouting }
}

const mintedFor = (worktreeId: string): string[] =>
  getHiddenRendererPtyIds().filter((id) => id.startsWith(`${worktreeId}@@`))

// Pins main's current launch behaviour as the convergence parity baseline (failure cleanup races).
describe('launch race parity: provisional size and hidden mark, both spawn lanes', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it('IPC lane restores the provisional size when building options fails (ipc/spawn-run.ts:66-69)', async () => {
    installLaunchRaceProvider(async () => ({ id: 'pty-must-not-spawn' }))
    let sizeWhileBuilding: unknown
    const runtime = createLaunchRaceRuntime({
      acquireWorktreeTerminalSpawn: vi.fn(async () => {
        sizeWhileBuilding = ptySizes.get('race-size-ipc')
        throw new Error('options failed')
      })
    })
    const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })
    ptySizes.delete('race-size-ipc')

    await expect(
      lanes.spawnThroughIpc({
        cols: 80,
        rows: 24,
        cwd: '/tmp/race-size-ipc',
        worktreeId: 'repo-1::/tmp/race-size-ipc',
        sessionId: 'race-size-ipc'
      })
    ).rejects.toThrow('options failed')

    expect(sizeWhileBuilding).toEqual({ cols: 80, rows: 24 })
    expect(ptySizes.has('race-size-ipc')).toBe(false)
  })

  it('runtime lane restores the provisional size when building options fails (runtime/spawn.ts:94-97)', async () => {
    const provider = installLaunchRaceProvider(async () => ({ id: 'pty-must-not-spawn' }))
    let sizeWhileBuilding: unknown
    Object.assign(provider, {
      supportsAgentSessionCreateOperations: vi.fn(async () => {
        sizeWhileBuilding = ptySizes.get('race-size-runtime')
        return false
      })
    })
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime: createLaunchRaceRuntime()
    })
    ptySizes.set('race-size-runtime', { cols: 100, rows: 30 })

    await expect(
      lanes.controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/race-size-runtime',
        worktreeId: 'repo-1::/tmp/race-size-runtime',
        sessionId: 'race-size-runtime',
        isNewSession: true,
        agentSessionCreateOperationId: 'op-race-size-runtime'
      })
    ).rejects.toThrow('execution_owner_unavailable')

    expect(sizeWhileBuilding).toEqual({ cols: 80, rows: 24 })
    expect(ptySizes.get('race-size-runtime')).toEqual({ cols: 100, rows: 30 })
    expect(provider.spawn).not.toHaveBeenCalled()
    ptySizes.delete('race-size-runtime')
  })

  it('IPC lane marks a fresh daemon session hidden before its preflight awaits (ipc/spawn-preflight.ts:42-48)', async () => {
    const worktreeId = 'repo-1::/tmp/race-hidden-early'
    installLaunchRaceProvider(async (options) => ({ id: String(options.sessionId) }))
    const auth = gatedClaudeAuth()
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime: createLaunchRaceRuntime(),
      prepareClaudeAuth: auth.prepareClaudeAuth
    })

    const spawn = lanes.spawnThroughIpc({
      cols: 80,
      rows: 24,
      cwd: '/tmp/race-hidden-early',
      worktreeId,
      command: 'claude',
      initiallyHidden: true
    })
    await vi.waitFor(() => expect(auth.prepareClaudeAuth).toHaveBeenCalledOnce())
    expect(mintedFor(worktreeId)).toHaveLength(1)

    auth.release()
    const result = await spawn
    expect(isHiddenRendererPty(result.id)).toBe(true)
  })

  it('IPC lane marks the session it recovers daemon routing for before preflight continues (ipc/spawn-preflight.ts:181-192)', async () => {
    const worktreeId = 'repo-1::/tmp/race-hidden-recovered'
    const { recoverFreshSpawnRouting } = installDegradedRaceProvider(async (options) => ({
      id: String(options.sessionId)
    }))
    const auth = gatedClaudeAuth()
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime: createLaunchRaceRuntime(),
      prepareClaudeAuth: auth.prepareClaudeAuth
    })

    const spawn = lanes.spawnThroughIpc({
      cols: 80,
      rows: 24,
      cwd: '/tmp/race-hidden-recovered',
      worktreeId,
      command: 'claude',
      initiallyHidden: true
    })
    await vi.waitFor(() => expect(auth.prepareClaudeAuth).toHaveBeenCalledOnce())
    expect(recoverFreshSpawnRouting).toHaveBeenCalledOnce()
    expect(mintedFor(worktreeId)).toHaveLength(1)

    auth.release()
    await expect(spawn).resolves.toMatchObject({ id: expect.stringMatching(/@@/) })
  })

  it('IPC lane rolls the pre-spawn hidden mark back on a throw outside the provider spawn (ipc/spawn-run.ts:82-84)', async () => {
    const worktreeId = 'repo-1::/tmp/race-hidden-rollback'
    installLaunchRaceProvider(async () => ({ id: 'pty-must-not-spawn' }))
    let markedWhileBuilding: string[] = []
    const runtime = createLaunchRaceRuntime({
      acquireWorktreeTerminalSpawn: vi.fn(async () => {
        markedWhileBuilding = mintedFor(worktreeId)
        throw new Error('options failed')
      })
    })
    const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

    await expect(
      lanes.spawnThroughIpc({
        cols: 80,
        rows: 24,
        cwd: '/tmp/race-hidden-rollback',
        worktreeId,
        initiallyHidden: true
      })
    ).rejects.toThrow('options failed')

    expect(markedWhileBuilding).toHaveLength(1)
    expect(mintedFor(worktreeId)).toEqual([])
  })

  it('runtime lane rolls the pre-spawn hidden mark back on a throw after the provider spawn (runtime/spawn.ts:106)', async () => {
    const worktreeId = 'repo-1::/tmp/race-hidden-rollback-runtime'
    let markedWhileSpawning: string[] = []
    installLaunchRaceProvider(async (options) => {
      markedWhileSpawning = mintedFor(worktreeId)
      return { id: String(options.sessionId) }
    })
    const runtime = createLaunchRaceRuntime({
      registerPty: vi.fn(() => {
        throw new Error('register failed')
      })
    })
    const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

    await expect(
      lanes.controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/race-hidden-rollback-runtime',
        worktreeId,
        initiallyHidden: true
      })
    ).rejects.toThrow('register failed')

    expect(markedWhileSpawning).toHaveLength(1)
    expect(mintedFor(worktreeId)).toEqual([])
  })

  it('IPC lane moves the hidden mark to the id the provider returned (ipc/spawn-commit-persist.ts:119-125)', async () => {
    installLaunchRaceProvider(async () => ({ id: 'pty-renamed-ipc' }))
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime: createLaunchRaceRuntime()
    })

    await lanes.spawnThroughIpc({ cols: 80, rows: 24, cwd: '/tmp', initiallyHidden: true })

    expect(getHiddenRendererPtyIds()).toEqual(['pty-renamed-ipc'])
  })

  it('runtime lane moves the hidden mark to the id the provider returned (runtime/spawn-hidden-delivery.ts:44-47)', async () => {
    installLaunchRaceProvider(async () => ({ id: 'pty-renamed-runtime' }))
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime: createLaunchRaceRuntime()
    })

    await lanes.controller.spawn({ cols: 80, rows: 24, cwd: '/tmp', initiallyHidden: true })

    expect(getHiddenRendererPtyIds()).toEqual(['pty-renamed-runtime'])
  })
})
