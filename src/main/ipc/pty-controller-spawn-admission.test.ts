import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  registerPtyHandlers,
  clearProviderPtyState,
  setLocalPtyProvider,
  isCurrentPtyExit,
  restorePtyIncarnation
} from './pty'

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

describe('registerPtyHandlers', () => {
  const {
    handlers,
    mainWindow,
    createAgentClaimProvider,
    recoveredAgentClaim,
    recoveredAgentSurface,
    registerAgentClaimController
  } = setupPtyIpcSuite()

  it('rejects renderer persistence when a local PTY exits before spawn settles', async () => {
    const ptyId = 'pty-renderer-early-exit'
    const incarnationId = 'incarnation-renderer-early-exit'
    const runtime = new OrcaRuntimeService()
    const registerRuntimePty = vi.spyOn(runtime, 'registerPty')
    const provider = createAgentClaimProvider({
      spawn: vi.fn(async () => {
        runtime.onPtySpawned(ptyId, incarnationId)
        runtime.onPtyExit(ptyId, 0, incarnationId)
        return { id: ptyId, incarnationId }
      }),
      authoritativeOwnerListings: false
    })
    const store = { persistPtyBinding: vi.fn() }
    setLocalPtyProvider(provider as never)
    registerPtyHandlers(
      mainWindow as never,
      runtime,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const leafId = '44444444-4444-4444-8444-444444444444'

    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp/worktree',
        worktreeId: 'repo::/tmp/worktree',
        tabId: 'tab-renderer-early-exit',
        leafId
      })
    ).rejects.toThrow('agent_session_exited_during_start')

    expect(store.persistPtyBinding).not.toHaveBeenCalled()
    expect(registerRuntimePty).not.toHaveBeenCalled()
    const internals = runtime as unknown as {
      earlyExitedPtyIncarnations: Map<string, string | null>
      pendingPtyRegistrationIncarnations: Map<string, string | null>
    }
    expect(internals.earlyExitedPtyIncarnations.size).toBe(0)
    expect(internals.pendingPtyRegistrationIncarnations.size).toBe(0)
    clearProviderPtyState(ptyId)
  })
  it('adopts a live controller-owned local fallback when listings cannot serialize claims', async () => {
    const sessions: {
      id: string
      incarnationId: string
      cwd: string
      title: string
    }[] = []
    const physicalSpawn = vi.fn(async () => {
      const result = { id: 'pty-local-claim', incarnationId: 'incarnation-local-claim' }
      sessions.push({ ...result, cwd: '/tmp/worktree', title: 'Codex' })
      return result
    })
    const provider = createAgentClaimProvider({
      sessions,
      spawn: physicalSpawn,
      authoritativeOwnerListings: false
    })
    Object.assign(provider, { routesFreshSpawnsToLocalProvider: true })
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController()
    const request = {
      cols: 80,
      rows: 24,
      cwd: '/tmp/worktree',
      agentSessionEnsure: {
        claim: recoveredAgentClaim,
        surface: recoveredAgentSurface
      }
    }

    await expect(controller.spawn(request)).resolves.toMatchObject({
      agentSessionEnsure: { disposition: 'created' }
    })
    await expect(controller.spawn(request)).resolves.toMatchObject({
      id: 'pty-local-claim',
      agentSessionEnsure: { disposition: 'adopted' }
    })
    expect(physicalSpawn).toHaveBeenCalledOnce()
    clearProviderPtyState('pty-local-claim')
  })
  it.each(['runtime controller', 'renderer IPC'] as const)(
    'recovers degraded fresh-spawn routing before %s chooses daemon host semantics',
    async (entryPoint) => {
      let degraded = true
      const daemonSpawn = vi.fn(async (options: { sessionId?: string }) => ({
        id: options.sessionId ?? 'unexpected-fallback-id'
      }))
      const provider = createAgentClaimProvider({ spawn: daemonSpawn })
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
      setLocalPtyProvider(provider as never)
      const controller = registerAgentClaimController()
      const worktreeId = 'repo::/tmp/recovered-daemon-routing'
      const spawnArgs = {
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-daemon-routing',
        worktreeId
      }

      await (entryPoint === 'runtime controller'
        ? controller.spawn(spawnArgs)
        : handlers.get('pty:spawn')!(null, spawnArgs))

      expect(recoverFreshSpawnRouting).toHaveBeenCalledOnce()
      expect(daemonSpawn).toHaveBeenCalledOnce()
      expect(daemonSpawn.mock.calls[0]?.[0].sessionId).toMatch(
        new RegExp(`^${worktreeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@@`)
      )
      expect(recoverFreshSpawnRouting.mock.invocationCallOrder[0]).toBeLessThan(
        daemonSpawn.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
      )
    }
  )
  it('recovers degraded routing for a fresh runtime session with a stable id', async () => {
    let degraded = true
    const daemonSpawn = vi.fn(async (options: { sessionId?: string; isNewSession?: boolean }) => ({
      id: options.sessionId ?? 'unexpected-fallback-id'
    }))
    const provider = createAgentClaimProvider({ spawn: daemonSpawn })
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
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController()

    await controller.spawn({
      cols: 80,
      rows: 24,
      cwd: '/tmp/recovered-stable-session',
      worktreeId: 'repo::/tmp/recovered-stable-session',
      sessionId: 'serve-stable-session',
      isNewSession: true
    })

    expect(recoverFreshSpawnRouting).toHaveBeenCalledOnce()
    expect(daemonSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'serve-stable-session', isNewSession: true })
    )
  })
  it('adopts a daemon owner recovered from provider listing before claimed ensure', async () => {
    const owner: AgentSessionOwnerBinding = {
      claim: recoveredAgentClaim,
      generation: 'generation-recovered',
      phase: 'live',
      ptyId: 'pty-recovered-owner',
      surface: recoveredAgentSurface
    }
    const provider = createAgentClaimProvider({
      sessions: [
        {
          id: owner.ptyId,
          incarnationId: 'incarnation-recovered',
          cwd: '/tmp/recovered-worktree',
          title: 'Codex',
          agentSessionOwners: [owner]
        }
      ],
      livePtyIds: new Set([owner.ptyId])
    })
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController()

    const result = await controller.spawn({
      cols: 80,
      rows: 24,
      cwd: '/tmp/recovered-worktree',
      agentSessionEnsure: { claim: recoveredAgentClaim, surface: recoveredAgentSurface }
    })

    expect(result).toMatchObject({
      id: owner.ptyId,
      incarnationId: 'incarnation-recovered',
      agentSessionEnsure: { disposition: 'adopted', owner }
    })
    expect(isCurrentPtyExit({ id: owner.ptyId })).toBe(false)
    expect(isCurrentPtyExit({ id: owner.ptyId, incarnationId: 'incarnation-old' })).toBe(false)
    expect(isCurrentPtyExit({ id: owner.ptyId, incarnationId: 'incarnation-recovered' })).toBe(true)
    expect(provider.spawn).not.toHaveBeenCalled()
    clearProviderPtyState(owner.ptyId)
  })
  it('releases an adopted-owner fence when that owner exits during admission', async () => {
    const incarnationId = 'incarnation-adopted-exit'
    const owner: AgentSessionOwnerBinding = {
      claim: recoveredAgentClaim,
      generation: 'generation-adopted-exit',
      phase: 'live',
      ptyId: 'pty-adopted-exit',
      surface: recoveredAgentSurface
    }
    const runtime = new OrcaRuntimeService()
    const provider = createAgentClaimProvider({
      sessions: [
        {
          id: owner.ptyId,
          incarnationId,
          cwd: '/tmp/recovered-worktree',
          title: 'Codex',
          agentSessionOwners: [owner]
        }
      ],
      livePtyIds: new Set([owner.ptyId])
    })
    provider.listProcesses.mockImplementation(async () => {
      if (provider.listProcesses.mock.calls.length > 1) {
        runtime.onPtyExit(owner.ptyId, 0, incarnationId)
      }
      return [
        {
          id: owner.ptyId,
          incarnationId,
          cwd: '/tmp/recovered-worktree',
          title: 'Codex',
          agentSessionOwners: [owner]
        }
      ]
    })
    setLocalPtyProvider(provider as never)
    registerPtyHandlers(mainWindow as never, runtime)
    const controller = (
      runtime as unknown as {
        ptyController: { spawn(args: Record<string, unknown>): Promise<unknown> }
      }
    ).ptyController

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        agentSessionEnsure: { claim: recoveredAgentClaim, surface: recoveredAgentSurface }
      })
    ).rejects.toThrow('agent_session_exited_during_start')

    const internals = runtime as unknown as {
      earlyExitedPtyIncarnations: Map<string, string | null>
    }
    expect(internals.earlyExitedPtyIncarnations.has(owner.ptyId)).toBe(false)
  })
  it('rejects stale exits immediately after SSH reconnect restores an incarnation', () => {
    const ptyId = 'ssh:target-1@@pty-reconnected'
    restorePtyIncarnation(ptyId, 'incarnation-current')

    expect(isCurrentPtyExit({ id: ptyId, incarnationId: 'incarnation-old' })).toBe(false)
    expect(isCurrentPtyExit({ id: ptyId, incarnationId: 'incarnation-current' })).toBe(true)
    clearProviderPtyState(ptyId)
  })
  it('fails closed when a recovered claimed owner omits incarnation proof', async () => {
    const owner: AgentSessionOwnerBinding = {
      claim: {
        ...recoveredAgentClaim,
        identityDigest: '1212121212121212121212121212121212121212121'
      },
      generation: 'generation-no-incarnation',
      phase: 'live',
      ptyId: 'pty-owner-without-incarnation',
      surface: recoveredAgentSurface
    }
    const provider = createAgentClaimProvider({
      sessions: [
        {
          id: owner.ptyId,
          cwd: '/tmp/recovered-worktree',
          title: 'Codex',
          agentSessionOwners: [owner]
        }
      ]
    })
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController()

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        agentSessionEnsure: { claim: owner.claim, surface: recoveredAgentSurface }
      })
    ).rejects.toThrow('agent_session_ownership_unknown')
    expect(provider.spawn).not.toHaveBeenCalled()
  })
})
