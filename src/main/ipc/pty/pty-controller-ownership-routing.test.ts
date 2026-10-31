import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import type { AgentSessionOwnerBinding } from '../../../shared/agent-session-host-authority'
import { LocalPtyProvider } from '../../providers/local-pty-provider'
import { registerPtyHandlers } from './register-handlers'
import { clearPtyOwnershipForConnection, clearProviderPtyState } from './provider/state-cleanup'
import { setPtyOwnership } from './provider/ownership-state'
import { setLocalPtyProvider } from './provider/registry'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
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

describe('registerPtyHandlers', () => {
  const {
    mainWindow,
    createAgentClaimProvider,
    recoveredAgentClaim,
    recoveredAgentSurface,
    registerAgentClaimController
  } = setupPtyIpcSuite()

  it('fails closed instead of routing encoded SSH PTY writes locally', () => {
    const ptyId = 'ssh:ssh-1@@remote-pty'
    const localProvider = createAgentClaimProvider({})
    setLocalPtyProvider(localProvider as never)
    const controller = registerAgentClaimController()

    expect(controller.write(ptyId, 'input')).toBe(false)
    expect(controller.resize(ptyId, 100, 40)).toBe(false)
    expect(localProvider.write).not.toHaveBeenCalled()
    expect(localProvider.resize).not.toHaveBeenCalled()
    clearProviderPtyState(ptyId)
  })
  it('preserves a provider write refusal for callers that gate follow-up input', () => {
    const provider = createAgentClaimProvider({})
    provider.write.mockReturnValue(false)
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController()

    expect(controller.write('pty-refused', 'input')).toBe(false)
    expect(provider.write).toHaveBeenCalledWith('pty-refused', 'input')
  })
  describe('controller probePtyLiveness routing', () => {
    it('proves absence for an id the in-process local provider never owned', async () => {
      setLocalPtyProvider(new LocalPtyProvider())
      const controller = registerAgentClaimController()

      await expect(controller.probePtyLiveness('pty-from-prior-run')).resolves.toBe(false)
    })

    it('delegates to a provider-exposed probe and preserves its answer', async () => {
      const provider = {
        ...createAgentClaimProvider({}),
        probePtyLiveness: vi.fn(async () => true)
      }
      setLocalPtyProvider(provider as never)
      const controller = registerAgentClaimController()

      await expect(controller.probePtyLiveness('daemon-owned')).resolves.toBe(true)
      expect(provider.probePtyLiveness).toHaveBeenCalledWith('daemon-owned')
    })

    it('answers unknown for a probe-less provider that is not the in-process one', async () => {
      // Only the in-process provider can prove sole ownership without a probe.
      setLocalPtyProvider(createAgentClaimProvider({}) as never)
      const controller = registerAgentClaimController()

      await expect(controller.probePtyLiveness('pty-unknown')).resolves.toBeNull()
    })

    it('answers unknown for remote-scoped ids without consulting local providers', async () => {
      // A local provider cannot prove ownership of a PTY on another host.
      setLocalPtyProvider(new LocalPtyProvider())
      const controller = registerAgentClaimController()

      await expect(controller.probePtyLiveness('remote:some-remote-pty')).resolves.toBeNull()
    })

    it('answers unknown when the provider probe throws', async () => {
      const provider = {
        ...createAgentClaimProvider({}),
        probePtyLiveness: vi.fn(async () => {
          throw new Error('probe transport down')
        })
      }
      setLocalPtyProvider(provider as never)
      const controller = registerAgentClaimController()

      await expect(controller.probePtyLiveness('daemon-owned')).resolves.toBeNull()
    })
  })
  it('routes controller attach to the local daemon provider only, false on doubt', async () => {
    const localProvider = createAgentClaimProvider({})
    setLocalPtyProvider(localProvider as never)
    const controller = registerAgentClaimController()
    const daemonPtyId = 'repo-1::/tmp/wt@@1a2b3c4d'
    const ownedSshPtyId = 'owned-remote-pty'
    setPtyOwnership(ownedSshPtyId, 'ssh:ssh-attach')
    try {
      await expect(controller.attach(daemonPtyId)).resolves.toBe(true)
      expect(localProvider.attach).toHaveBeenCalledWith(daemonPtyId)

      await expect(controller.attach(ownedSshPtyId)).resolves.toBe(false)
      await expect(controller.attach('ssh:ssh-attach@@relay-pty')).resolves.toBe(false)
      expect(localProvider.attach).toHaveBeenCalledTimes(1)

      localProvider.attach.mockRejectedValueOnce(new Error('Session not found'))
      await expect(controller.attach(daemonPtyId)).resolves.toBe(false)

      const inProcess = new LocalPtyProvider()
      const inProcessAttach = vi.spyOn(inProcess, 'attach')
      setLocalPtyProvider(inProcess)
      await expect(controller.attach(daemonPtyId)).resolves.toBe(false)
      expect(inProcessAttach).not.toHaveBeenCalled()
    } finally {
      clearPtyOwnershipForConnection('ssh-attach')
      clearProviderPtyState(ownedSshPtyId)
    }
  })
  it('synchronizes subscriber-driven attach to the daemon snapshot sequence', async () => {
    const daemonPtyId = 'repo-1::/tmp/wt@@sequence-handoff'
    const providerSequence = { value: 204, generation: 'continued' as const }
    const localProvider = createAgentClaimProvider({})
    localProvider.attach.mockResolvedValueOnce({ providerSequence })
    setLocalPtyProvider(localProvider as never)
    const getPtyOutputSequence = vi.fn(() => 0)
    const synchronizePtyOutputSequenceFromProvider = vi.fn()
    const controller = registerAgentClaimController({
      getPtyOutputSequence,
      synchronizePtyOutputSequenceFromProvider
    })

    await expect(controller.attach(daemonPtyId)).resolves.toBe(true)

    expect(getPtyOutputSequence).toHaveBeenCalledWith(daemonPtyId)
    expect(synchronizePtyOutputSequenceFromProvider).toHaveBeenCalledWith(
      daemonPtyId,
      providerSequence,
      0
    )
  })
  it('seeds the screen and title of a session adopted by main attach', async () => {
    const daemonPtyId = 'repo-1::/tmp/wt@@title-handoff'
    const localProvider = createAgentClaimProvider({})
    localProvider.attach.mockResolvedValueOnce({
      id: daemonPtyId,
      snapshot: 'idle composer\r\n',
      snapshotCols: 120,
      snapshotRows: 40,
      lastTitle: '⠋ Claude'
    })
    setLocalPtyProvider(localProvider as never)
    const seedHeadlessTerminal = vi.fn()
    const seedTerminalRestoreTail = vi.fn()
    const controller = registerAgentClaimController({
      seedHeadlessTerminal,
      seedTerminalRestoreTail
    })

    await expect(controller.attach(daemonPtyId)).resolves.toBe(true)

    expect(seedHeadlessTerminal).toHaveBeenCalledWith(
      daemonPtyId,
      'idle composer\r\n',
      { cols: 120, rows: 40 },
      {}
    )
    expect(seedTerminalRestoreTail).toHaveBeenCalledWith(daemonPtyId, {
      text: 'idle composer\r\n',
      lastTitle: '⠋ Claude'
    })
  })
  it('does not dispatch a runtime PTY spawn after its client disconnects', async () => {
    const provider = createAgentClaimProvider({})
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController()
    const abort = new AbortController()
    abort.abort()

    await expect(
      controller.spawn({ cols: 80, rows: 24, cwd: '/tmp/worktree', signal: abort.signal })
    ).rejects.toThrow('client_disconnected')
    expect(provider.spawn).not.toHaveBeenCalled()
  })
  it('rejects a canonical daemon owner that exited before its spawn reply', async () => {
    const claim = {
      ...recoveredAgentClaim,
      identityDigest: 'ededededededededededededededededededededede'
    }
    const canonicalOwner: AgentSessionOwnerBinding = {
      claim,
      generation: 'generation-canonical-exited',
      phase: 'live',
      ptyId: 'pty-canonical-exited',
      surface: recoveredAgentSurface
    }
    const physicalSpawn = vi.fn(async () => ({
      id: canonicalOwner.ptyId,
      incarnationId: 'incarnation-canonical-exited',
      exitedBeforeSpawnReply: true as const,
      agentSessionEnsure: { disposition: 'adopted' as const, owner: canonicalOwner }
    }))
    const provider = createAgentClaimProvider({ spawn: physicalSpawn })
    setLocalPtyProvider(provider as never)
    let controller: { spawn(args: Record<string, unknown>): Promise<unknown> } | undefined
    const runtime = {
      setPtyController: vi.fn((next) => {
        controller = next
      }),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)

    await expect(
      controller!.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        sessionId: 'different-requested-id',
        agentSessionEnsure: { claim, surface: recoveredAgentSurface }
      })
    ).rejects.toThrow('agent_session_exited_during_start')

    expect(physicalSpawn).toHaveBeenCalledOnce()
    expect(runtime.registerPty).not.toHaveBeenCalled()
    expect(runtime.registerPreAllocatedHandleForPty).not.toHaveBeenCalled()
    expect(runtime.cancelPendingPtyRegistration).toHaveBeenCalledWith(
      'different-requested-id',
      'incarnation-canonical-exited',
      undefined
    )
  })
})

describe('PTY controller ownership recovery', () => {
  const {
    createAgentClaimProvider,
    recoveredAgentClaim,
    recoveredAgentSurface,
    registerAgentClaimController
  } = setupPtyIpcSuite()

  it('does not adopt a stale generation when its PTY id is reused without ownership', async () => {
    const claim = {
      ...recoveredAgentClaim,
      identityDigest: 'fffffffffffffffffffffffffffffffffffffffffff'
    }
    const oldOwner: AgentSessionOwnerBinding = {
      claim,
      generation: 'generation-old',
      phase: 'live',
      ptyId: 'pty-reused',
      surface: recoveredAgentSurface
    }
    const sessions = [
      {
        id: oldOwner.ptyId,
        incarnationId: 'incarnation-old',
        cwd: '/tmp/recovered-worktree',
        title: 'Codex',
        agentSessionOwners: [oldOwner]
      }
    ]
    const spawn = vi.fn(
      async (options: {
        agentSessionEnsure?: { claim: typeof claim; surface: typeof recoveredAgentSurface }
      }) => {
        const ensured = options.agentSessionEnsure
        if (!ensured) {
          throw new Error('missing test claim')
        }
        const owner: AgentSessionOwnerBinding = {
          claim: ensured.claim,
          generation: 'generation-new',
          phase: 'live',
          ptyId: 'pty-new-owner',
          surface: ensured.surface
        }
        sessions.push({
          id: owner.ptyId,
          incarnationId: 'incarnation-new',
          cwd: '/tmp/recovered-worktree',
          title: 'Codex',
          agentSessionOwners: [owner]
        })
        return {
          id: owner.ptyId,
          agentSessionEnsure: { disposition: 'created' as const, owner }
        }
      }
    )
    const provider = createAgentClaimProvider({ sessions, spawn })
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController()
    const request = {
      cols: 80,
      rows: 24,
      cwd: '/tmp/recovered-worktree',
      agentSessionEnsure: { claim, surface: recoveredAgentSurface }
    }

    await expect(controller.spawn(request)).resolves.toMatchObject({ id: oldOwner.ptyId })
    sessions[0] = { ...sessions[0], agentSessionOwners: [] }
    await expect(controller.spawn(request)).resolves.toMatchObject({
      id: 'pty-new-owner',
      agentSessionEnsure: { disposition: 'created' }
    })
    expect(spawn).toHaveBeenCalledOnce()

    clearProviderPtyState(oldOwner.ptyId)
    clearProviderPtyState('pty-new-owner')
  })
})
