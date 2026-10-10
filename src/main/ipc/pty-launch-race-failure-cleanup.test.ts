import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { getHiddenRendererPtyIds, isHiddenRendererPty } from './pty-hidden-delivery-gate'
import { ptySizes } from './pty/delivery/visibility-state'
import {
  LAUNCH_RACE_LANES,
  createLaunchRaceRuntime,
  gatedClaudeAuth,
  installLaunchRaceProvider,
  registerLaunchRaceLanes,
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

// Pins main's current launch behaviour as the baseline the spawn-lane merge must keep.
describe('launch race parity: cleanup when a start fails, both spawn lanes', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  // Row 5: a failed options build puts the session's size back (ipc/spawn-run.ts:66-69 with its
  // capture at ipc/spawn-options.ts:154-157; runtime/spawn.ts:94-97 with runtime/spawn-options.ts:159-162).
  // Each lane fails its options build its own way; the outcome is the same.
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
      const provider = installLaunchRaceProvider(async () => ({ id: 'pty-must-not-spawn' }))
      Object.assign(provider, {
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

      if (!cached) {
        expect(sizeWhileBuilding).toEqual({ cols: 80, rows: 24 })
      }
      expect(ptySizes.get(sessionId)).toEqual(cached)
      expect(provider.spawn).not.toHaveBeenCalled()
    })
  })

  // Row 7 (window lane): the mark is set before preflight's first await (ipc/spawn-preflight.ts:42-48).
  it('window lane marks a fresh daemon session hidden before its preflight awaits', async () => {
    const worktreeId = 'repo-1::/tmp/race-hidden-early'
    installLaunchRaceProvider(async (options) => ({ id: String(options.sessionId) }))
    const auth = gatedClaudeAuth()
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime: createLaunchRaceRuntime(),
      prepareClaudeAuth: auth.prepareClaudeAuth
    })

    const spawn = lanes.spawn.ipc({
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
    expect(isHiddenRendererPty((await spawn).id)).toBe(true)
  })

  // Row 7 (window lane): recovering daemon routing mints a session and marks it (ipc/spawn-preflight.ts:181-192).
  it('window lane marks the session it recovers daemon routing for before preflight continues', async () => {
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

    const spawn = lanes.spawn.ipc({
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

  // Row 7: any throw rolls the pre-spawn mark back (ipc/spawn-run.ts:82-84; runtime/spawn.ts:106).
  it.each(LAUNCH_RACE_LANES)(
    '%s lane: a throw after the provider spawn rolls the pre-spawn hidden mark back',
    async (lane) => {
      const worktreeId = `repo-1::/tmp/race-hidden-rollback-${lane}`
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
        lanes.spawn[lane]({ cols: 80, rows: 24, cwd: '/tmp', worktreeId, initiallyHidden: true })
      ).rejects.toThrow('register failed')

      expect(markedWhileSpawning).toHaveLength(1)
      expect(mintedFor(worktreeId)).toEqual([])
    }
  )

  // Row 7: the mark follows the id the provider returned (ipc/spawn-commit-persist.ts:122-125;
  // runtime/spawn-hidden-delivery.ts:44-47).
  it.each(LAUNCH_RACE_LANES)(
    '%s lane: the hidden mark moves to the id the provider returned',
    async (lane) => {
      installLaunchRaceProvider(async () => ({ id: `pty-renamed-${lane}` }))
      const lanes = registerLaunchRaceLanes({
        handlers,
        mainWindow,
        runtime: createLaunchRaceRuntime()
      })

      await lanes.spawn[lane]({ cols: 80, rows: 24, cwd: '/tmp', initiallyHidden: true })

      expect(getHiddenRendererPtyIds()).toEqual([`pty-renamed-${lane}`])
    }
  )

  // Row 7 drift: IPC re-marks every hidden-requested result after its save
  // (ipc/spawn-commit-persist.ts:119-121); the runtime lane skips a reattach
  // (runtime/spawn-hidden-delivery.ts:31; also pty-runtime-hidden-at-spawn-mark.test.ts).
  const HIDDEN_REATTACH: Record<LaunchRaceLane, boolean> = { ipc: true, runtime: false }
  it.each(LAUNCH_RACE_LANES)('%s lane: a hidden-requested reattach', async (lane) => {
    const sessionId = `race-hidden-reattach-${lane}`
    installLaunchRaceProvider(async () => ({ id: sessionId, isReattach: true }))
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime: createLaunchRaceRuntime()
    })

    await lanes.spawn[lane]({ cols: 80, rows: 24, cwd: '/tmp', sessionId, initiallyHidden: true })

    expect(isHiddenRendererPty(sessionId)).toBe(HIDDEN_REATTACH[lane])
  })
})
