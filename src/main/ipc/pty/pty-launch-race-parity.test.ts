import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { TerminalCreateOptions } from '../../runtime/runtime-terminal-contracts'
import { registerPtyHandlers } from './register-handlers'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { launchWorkspaceId } from '../../../shared/launch-parity-window-request.test-fixture'
import { POSIX_PATH } from '../../../shared/launch-parity-window-cases.test-fixture'
import { statSyncMock, forgetRefusedPaneResumeMock } from './pty-ipc-mock-registry'
import {
  spawnBoth,
  startParityLanes,
  setMainPlatform,
  restoreMainPlatform
} from './pty-launch-parity.test-fixture'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type * as JcodeRuntimeDir from '../../../shared/jcode-runtime-dir'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { getHiddenRendererPtyIds, isHiddenRendererPty } from './delivery/pty-hidden-delivery-gate'
import { ptySizes } from './delivery/visibility-state'
import { clearProviderPtyState } from './provider/state-cleanup'
import * as paneSpawnReservations from './pane/spawn-reservation'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from '../../runtime/worktree-terminals-sleeping-error'
import { RestoredPaneStarter } from '../../runtime/terminal/recovery/restored-pane-start'
import {
  LAUNCH_RACE_LANES,
  createPaneBindingStore,
  createLaunchRaceRuntime,
  gatedClaudeAuth,
  launchRacePane,
  registerLaunchRaceLanes,
  sleptWorktreeLock,
  type LaunchRaceLane
} from './pty-launch-race-test-fixture'

import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../shared/agent-session-record.test-fixture'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).fsPromisesModuleMock(await importOriginal())
)
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)
// Real mkdir uses thread-pool I/O and could outlast the fixture's fixed macrotask drain under load.
vi.mock('../../../shared/jcode-runtime-dir', async (importOriginal) => {
  const actual = await importOriginal<typeof JcodeRuntimeDir>()
  return {
    ...actual,
    ensureJcodeRuntimeDir: async (paneKey: string) => actual.buildJcodeRuntimeDirEnv(paneKey)
  }
})

const mintedFor = (worktreeId: string): string[] =>
  getHiddenRendererPtyIds().filter((id) => id.startsWith(`${worktreeId}@@`))

describe('launch race parity, both spawn lanes', () => {
  const suite = setupPtyIpcSuite()
  const { handlers, mainWindow, installDaemonTestProvider } = suite

  it.each([
    { winner: 'producer', surface: 'existing' },
    { winner: 'producer', surface: 'new' },
    { winner: 'window', surface: 'existing' },
    { winner: 'producer', surface: 'successor' }
  ])(
    '$winner registration exit crosses the real producer/admission barrier ($surface)',
    async ({ winner, surface }) => {
      const pane = launchRacePane(
        `cross-${winner}-${surface}`,
        '94949494-9494-4494-8494-949494949494'
      )
      const store = Object.assign(createPaneBindingStore(), { getSettings: () => ({}) })
      const runtime = new OrcaRuntimeService()
      Object.assign(runtime, {
        store,
        resolveTerminalWorkspaceLaunchScope: async () => ({
          id: pane.worktreeId,
          path: pane.args.cwd,
          connectionId: null
        }),
        resolveAgentTerminalCreateOptions: async (
          _workspace: unknown,
          opts: TerminalCreateOptions
        ) => opts,
        resolveWorkspaceTerminalStartupCwd: () => pane.args.cwd
      })
      // SAFETY: the handler fixture supplies window ports; only the real mutable session and binding store are used.
      registerPtyHandlers(
        mainWindow as never,
        runtime,
        undefined,
        undefined,
        undefined,
        store as never
      )
      const admission = {
        type: 'createTerminalTab',
        workspace: pane.worktreeId,
        tabId: pane.tabId,
        leafId: pane.leafId
      } as const
      if (surface !== 'new') {
        runtime.attachWindow(1)
        runtime.syncWindowGraph(1, {
          tabs: [
            {
              tabId: pane.tabId,
              worktreeId: pane.worktreeId,
              title: 'terminal',
              activeLeafId: pane.leafId,
              layout: null
            }
          ],
          leaves: [
            {
              tabId: pane.tabId,
              worktreeId: pane.worktreeId,
              leafId: pane.leafId,
              paneRuntimeId: 1,
              ptyId: null
            }
          ]
        })
        await store.admitTerminalPane(admission)
      }
      let release!: () => void
      const gate = new Promise<void>((done) => {
        release = done
      })
      const spawn = vi.fn(async () => {
        await gate
        return {
          id: 'cross-exited',
          incarnationId: 'cross-inc',
          snapshot: 'final output',
          snapshotKittyKeyboardFlags: 3
        }
      })
      installDaemonTestProvider({ spawn })
      vi.spyOn(runtime, 'registerPty').mockImplementation(() => {
        throw new Error('agent_session_exited_during_start')
      })
      vi.spyOn(runtime, 'getPtyLivenessVerdict').mockReturnValue({ status: 'exited' })
      const withdraw = vi.spyOn(store, 'withdrawTerminalPane')
      const windowStart = () => Promise.resolve(handlers.get('pty:spawn')!(null, pane.args))
      const producerStart = () =>
        runtime.createTerminal(`id:${pane.worktreeId}`, { tabId: pane.tabId, leafId: pane.leafId })
      const first = winner === 'producer' ? producerStart() : windowStart()
      const firstObserved = first.catch((error: unknown) => error)
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
      const joined = vi.spyOn(paneSpawnReservations, 'joinPaneSpawn')
      onTestFinished(() => joined.mockRestore())
      const second = winner === 'producer' ? windowStart() : producerStart()
      const secondObserved = second.catch((error: unknown) => error)
      const key = paneSpawnReservations.makePaneSpawnReservationKey(
        pane.worktreeId,
        null,
        makePaneKey(pane.tabId, pane.leafId)
      )!
      const canonical = paneSpawnReservations.paneSpawnReservationsByOwnerKey.get(key)!
      if (winner === 'producer') {
        const pending = paneSpawnReservations.pendingRuntimePaneCreatesByOwnerKey.get(key)!
        const barrier = pending.promise
        const waiting = vi.fn(() => barrier)
        Object.defineProperty(pending, 'promise', { configurable: true, get: waiting })
        await vi.waitFor(() => expect(waiting).toHaveBeenCalled())
      } else {
        await vi.waitFor(() => expect(joined).toHaveBeenCalledOnce())
      }
      if (surface === 'successor') {
        const mutate = store.runDurableMutation.bind(store)
        vi.spyOn(store, 'runDurableMutation').mockImplementation(async (write) => {
          const value = await mutate(write)
          if (!store.getWorkspaceSession().terminalLayoutsByTabId[pane.tabId]) {
            await store.admitTerminalPane(admission)
            await store.persistPtyBinding({
              worktreeId: pane.worktreeId,
              tabId: pane.tabId,
              leafId: pane.leafId,
              ptyId: 'successor',
              incarnationId: 'successor-inc'
            })
          }
          return value
        })
      }
      release()
      const [firstResult, secondResult] = await Promise.all([firstObserved, secondObserved])
      const host = winner === 'producer' ? firstResult : secondResult
      const window = winner === 'producer' ? secondResult : firstResult
      expect(canonical.outcome?.kind).toBe('registration-exited')
      expect(canonical.outcome?.result).not.toHaveProperty('isReattach')
      expect(host).toMatchObject({ message: 'agent_session_exited_during_start' })
      if (surface === 'existing') {
        expect(window).toMatchObject({
          id: 'cross-exited',
          snapshot: 'final output',
          snapshotKittyKeyboardFlags: undefined,
          ...(winner === 'producer' ? { isReattach: true } : {})
        })
        if (winner === 'window') {
          expect(window).not.toHaveProperty('isReattach')
        }
      } else {
        expect(window).toMatchObject({ message: 'terminal_pane_owner_changed' })
      }
      expect(spawn).toHaveBeenCalledOnce()
      if (surface === 'new') {
        expect(withdraw).toHaveBeenCalledOnce()
        expect(store.getWorkspaceSession().terminalLayoutsByTabId[pane.tabId]).toBeUndefined()
      }
      clearProviderPtyState('cross-exited')
    }
  )
  it('restores a persisted window owner without imposing the runtime handle requirement', async () => {
    const pane = launchRacePane('restore-no-handle', '95959595-9595-4595-8595-959595959595')
    const id = 'persisted-no-handle'
    const store = createPaneBindingStore()
    await store.admitTerminalPane({
      type: 'createTerminalTab',
      workspace: pane.worktreeId,
      tabId: pane.tabId,
      leafId: pane.leafId
    })
    await store.persistPtyBinding({
      worktreeId: pane.worktreeId,
      tabId: pane.tabId,
      leafId: pane.leafId,
      ptyId: id
    })
    const runtime = createLaunchRaceRuntime({
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      })
    })
    installDaemonTestProvider({ spawn: vi.fn(async () => ({ id, isReattach: true })) })
    const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime, store })
    await expect(lanes.spawn.runtime(pane.args)).rejects.toThrow('terminal_pane_owner_unknown')
    await expect(lanes.spawn.ipc(pane.args)).resolves.toMatchObject({ id, isReattach: true })
    clearProviderPtyState(id)
  })
  it.each(LAUNCH_RACE_LANES)(
    '%s lane: auth failure before geometry acquisition preserves the existing grid',
    async (lane) => {
      const id = `pre-seed-auth-${lane}`
      const cached = { cols: 180, rows: 50 }
      ptySizes.set(id, cached)
      onTestFinished(() => {
        ptySizes.delete(id)
      })
      const spawn = vi.fn()
      installDaemonTestProvider({ spawn })
      const prepareClaudeAuth = vi.fn(async () => {
        throw new Error('auth unavailable')
      })
      const lanes = registerLaunchRaceLanes({
        handlers,
        mainWindow,
        runtime: createLaunchRaceRuntime(),
        prepareClaudeAuth
      })
      await expect(
        lanes.spawn[lane]({ cols: 80, rows: 24, sessionId: id, command: 'claude' })
      ).rejects.toThrow('auth unavailable')
      expect(prepareClaudeAuth).toHaveBeenCalledOnce()
      expect(spawn).not.toHaveBeenCalled()
      expect(ptySizes.get(id)).toEqual(cached)
    }
  )

  it('runtime joins known pane coordinates without workspace before auth preparation', async () => {
    const id = 'no-workspace-winner'
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    const spawn = vi.fn(async () => {
      await gate
      return { id }
    })
    installDaemonTestProvider({ spawn })
    const auth = vi.fn(async () => {
      throw new Error('duplicate auth')
    })
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime: createLaunchRaceRuntime(),
      prepareClaudeAuth: auth
    })
    const args = {
      cols: 80,
      rows: 24,
      tabId: 'tab-no-workspace',
      leafId: '96969696-9696-4696-8696-969696969696'
    }
    const winner = lanes.spawn.runtime(args)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    const joining = vi.spyOn(paneSpawnReservations, 'joinPaneSpawn')
    onTestFinished(() => joining.mockRestore())
    const joiner = lanes.spawn.runtime({ ...args, command: 'claude' })
    const observed = joiner.catch((error: unknown) => error)
    try {
      await vi.waitFor(() => expect(joining).toHaveBeenCalledOnce())
    } finally {
      release()
    }
    await expect(winner).resolves.toMatchObject({ id })
    await expect(observed).resolves.toMatchObject({ id })
    expect(auth).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledOnce()
    clearProviderPtyState(id)
  })

  it('seeds a fresh same-id incarnation before provider byte zero and restores a failed start', async () => {
    const id = 'fresh-same-id-grid'
    const old = { cols: 91, rows: 31 }
    ptySizes.set(id, old)
    const spawn = vi.fn(async () => {
      expect(ptySizes.get(id)).toEqual({ cols: 132, rows: 45 })
      throw new Error('provider refused')
    })
    installDaemonTestProvider({ spawn })
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime: createLaunchRaceRuntime()
    })
    await expect(
      lanes.spawn.runtime({ cols: 132, rows: 45, sessionId: id, isNewSession: true })
    ).rejects.toThrow('provider refused')
    expect(ptySizes.get(id)).toEqual(old)
    ptySizes.delete(id)
  })
  it('allows fallback for an unreadable request without healing its saved folder or mobile snapshot', async () => {
    setMainPlatform('darwin')
    onTestFinished(restoreMainPlatform)
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const POSIX_REPO = { kind: 'repo', path: POSIX_PATH } as const
    const unreadable = `${POSIX_PATH}/private`
    statSyncMock.mockImplementation((target: string) => {
      if (target === unreadable) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
      return { isDirectory: () => true, mode: 0o755 }
    })
    const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
    const facts = await spawnBoth(
      lanes,
      POSIX_REPO,
      { cwd: unreadable },
      { cwd: unreadable, persistHostSessionBinding: true }
    )
    expect(facts.host).toMatchObject({
      cwd: POSIX_PATH,
      created: {
        savedStartupCwd: unreadable,
        startupCwdFallback: { kind: 'worktree', cwd: POSIX_PATH }
      }
    })
    expect(lanes.persistPtyBinding).toHaveBeenCalledWith(
      expect.objectContaining({ startupCwd: unreadable })
    )
    for (const [binding] of lanes.persistPtyBinding.mock.calls) {
      expect(binding).not.toHaveProperty('correctStartupCwd')
    }
    const snapshot = await lanes.runtime.listMobileSessionTabs(
      `id:${launchWorkspaceId(POSIX_REPO)}`
    )
    expect(snapshot.tabs.find((tab) => tab.type === 'terminal')).toMatchObject({
      startupCwd: unreadable
    })
  })

  describe('who owns the pane', () => {
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
          // Both lanes join before any fresh launch preparation.
          await vi.waitFor(() => expect(joinPaneSpawn).toHaveBeenCalledOnce())
        }
        finishSpawn()

        await expect(winner).resolves.toMatchObject({ id: 'pty-join-winner' })
        await expect(joiner).resolves.toMatchObject({ id: 'pty-join-winner' })
        expect(spawn).toHaveBeenCalledOnce()
        expect(auth.prepareClaudeAuth).not.toHaveBeenCalled()
      }
    )

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
        .runtime({
          ...pane.args,
          refuseSleptWorktree: true,
          paneSpawnOperation: { mustExist: false }
        })
        .finally(release)
      await vi.waitFor(() => expect(lock.acquireWorktreeTerminalSpawn).toHaveBeenCalledOnce())
      const mount = lanes.spawn.ipc(pane.args)
      lock.refuse()

      await expect(automatic).rejects.toThrow(WORKTREE_TERMINALS_SLEEPING_ERROR)
      await expect(mount).resolves.toMatchObject({ id: 'pty-user-mount' })
      expect(spawn).toHaveBeenCalledOnce()
    })
  })

  it('starts a restored pane once for a window restore, a client first view and a CLI send', async () => {
    const pane = launchRacePane('race-three-starters', '73737373-7373-4373-8373-737373737373')
    let finishSpawn!: () => void
    const spawn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSpawn = () => resolve({ id: 'pty-restored' })
          })
      )
      .mockRejectedValue(new Error('second_terminal_started'))
    installDaemonTestProvider({ spawn })
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime: createLaunchRaceRuntime()
    })
    // The pane main holds: bound to the terminal that binds it, live once registered.
    let bound: string | undefined
    const window = lanes.spawn.ipc(pane.args).then((reply) => {
      bound = reply.id
      return reply
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    const joinPaneSpawn = vi.spyOn(paneSpawnReservations, 'joinPaneSpawn')
    onTestFinished(() => joinPaneSpawn.mockRestore())
    const starter = new RestoredPaneStarter({
      boundPtyId: () => bound,
      isLive: (ptyId) => ptyId === bound,
      start: async () => ({ id: (await lanes.spawn.runtime(pane.args)).id })
    })
    const restored = { worktreeId: pane.worktreeId, tabId: pane.tabId, leafId: pane.leafId }
    const firstView = starter.ensureStarted(restored)
    const cliSend = starter.ensureStarted(restored)
    await vi.waitFor(() => expect(joinPaneSpawn).toHaveBeenCalled())
    finishSpawn()

    await expect(window).resolves.toMatchObject({ id: 'pty-restored' })
    await expect(Promise.all([firstView, cliSend])).resolves.toEqual(
      Array.from({ length: 2 }, () => ({ id: 'pty-restored' }))
    )
    expect(spawn).toHaveBeenCalledOnce()
    expect(mintedFor(pane.worktreeId)).toEqual([])
  })

  describe('cleanup when a start fails', () => {
    // Host preparation temporarily overwrites cached size before restoring it.
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

    // Current reattach difference: window preserves the hidden mark; host skips it.
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

    // Failed binding saves discard the PTY and cancel registration.
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
        expect(runtime.cancelPendingPtyRegistration).toHaveBeenCalledWith(ptyId, 'inc-1', undefined)
      }
    )

    // Current lane difference: host rejects an incarnation that exits during registration.
    const EXITED_DURING_REGISTRATION: Record<LaunchRaceLane, 'resolves' | 'rejects'> = {
      ipc: 'resolves',
      runtime: 'rejects'
    }
    it.each(LAUNCH_RACE_LANES)(
      '%s lane: an incarnation that exits while it is registered',
      async (lane) => {
        const pane = launchRacePane(`race-exited-${lane}`, '83838383-8383-4383-8383-838383838383')
        const ptyId = `pty-exited-${lane}`
        const paneKey = makePaneKey(pane.tabId, pane.leafId)
        const providerSession = { key: 'session_id' as const, id: 'provider-session-alpha-1' }
        const chat = agentSessionRecordFixture(
          agentSessionLeaseFixture({
            claimStatus: 'released',
            ownerProcess: null,
            reservedSpawnToken: null,
            deathEvidence: { kind: 'exit-observed', detail: 'closed', observedAt: 1 }
          })
        )
        const records: AgentSessionRecordStore = Object.create(AgentSessionRecordStore.prototype)
        records.listConversations = () => [agentSessionConversationView(chat)]
        records.getVisibleSessionTabIndex = () => ({ present: true, sessionIds: [chat.sessionId] })
        const forget = vi.fn(async () => {})
        const remember = vi.fn()
        installDaemonTestProvider({
          spawn: vi.fn(async () => ({
            id: ptyId,
            incarnationId: 'inc-exited',
            coldRestore: { scrollback: 'final', cwd: '/tmp' }
          }))
        })
        const runtime = createLaunchRaceRuntime({
          registerPty: vi.fn(() => {
            throw new Error('agent_session_exited_during_start')
          }),
          getPtyLivenessVerdict: vi.fn(() => ({ status: 'exited' })),
          openAgentSessionRecordStore: async () => records,
          getAgentProviderSessionRows: () => [
            {
              paneKey,
              connectionId: null,
              agentType: 'claude',
              state: 'working',
              prompt: '',
              receivedAt: 1,
              stateStartedAt: 1,
              providerSession
            }
          ],
          forgetRefusedSavedResume: forget,
          rememberSavedTerminalLaunchResult: remember
        })
        const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })
        forgetPtyAfterTest(ptyId)

        const spawn = lanes.spawn[lane](pane.args)

        await (EXITED_DURING_REGISTRATION[lane] === 'resolves'
          ? expect(spawn).resolves.toMatchObject({
              id: ptyId,
              incarnationId: 'inc-exited',
              agentResumeRefused: 'chat-home',
              savedResumeDecision: { agent: 'claude', providerSession, verdict: 'chat-home' }
            })
          : expect(spawn).rejects.toThrow('agent_session_exited_during_start'))
        expect(runtime.cancelPendingPtyRegistration).toHaveBeenCalledWith(
          ptyId,
          'inc-exited',
          undefined
        )
        expect(runtime.noteTerminalSpawnCommit).not.toHaveBeenCalled()
        expect(runtime.reflowHeadlessTerminalToPtyGrid).not.toHaveBeenCalled()
        expect([
          forget.mock.calls.length,
          remember.mock.calls.length,
          forgetRefusedPaneResumeMock.mock.calls.length
        ]).toEqual(lane === 'ipc' ? [1, 1, 1] : [0, 0, 0])
      }
    )

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
