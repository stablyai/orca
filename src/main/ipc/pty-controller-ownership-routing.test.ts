import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import {
  registerPtyHandlers,
  registerSshPtyProvider,
  clearPtyOwnershipForConnection,
  clearProviderPtyState,
  getPtyIdsForConnection,
  setPtyOwnership,
  setLocalPtyProvider,
  unregisterSshPtyProvider
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

  it('fails closed instead of routing encoded SSH PTY writes locally after disconnect', () => {
    const connectionId = 'ssh-1'
    const ptyId = `ssh:${connectionId}@@remote-pty`
    const localProvider = createAgentClaimProvider({})
    const sshProvider = createAgentClaimProvider({})
    setLocalPtyProvider(localProvider as never)
    registerSshPtyProvider(connectionId, sshProvider as never)
    setPtyOwnership(ptyId, connectionId)
    const controller = registerAgentClaimController()

    unregisterSshPtyProvider(connectionId)
    clearPtyOwnershipForConnection(connectionId)

    expect(controller.write(ptyId, 'input')).toBe(false)
    expect(controller.resize(ptyId, 100, 40)).toBe(false)
    expect(localProvider.write).not.toHaveBeenCalled()
    expect(localProvider.resize).not.toHaveBeenCalled()

    registerSshPtyProvider(connectionId, sshProvider as never)
    expect(controller.write(ptyId, 'reconnected')).toBe(true)
    expect(controller.resize(ptyId, 120, 50)).toBe(true)
    expect(sshProvider.write).toHaveBeenCalledWith(ptyId, 'reconnected')
    expect(sshProvider.resize).toHaveBeenCalledWith(ptyId, 120, 50)

    unregisterSshPtyProvider(connectionId)
    clearProviderPtyState(ptyId)
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
      // Why: only the in-process provider is its own sole owner; any other
      // probe-less provider's ignorance is doubt, not absence.
      setLocalPtyProvider(createAgentClaimProvider({}) as never)
      const controller = registerAgentClaimController()

      await expect(controller.probePtyLiveness('pty-unknown')).resolves.toBeNull()
    })

    it('answers unknown for SSH-owned ids whose provider has no probe', async () => {
      const connectionId = 'ssh-probe-1'
      const ptyId = `ssh:${connectionId}@@remote-pty`
      setLocalPtyProvider(new LocalPtyProvider())
      registerSshPtyProvider(connectionId, createAgentClaimProvider({}) as never)
      setPtyOwnership(ptyId, connectionId)
      const controller = registerAgentClaimController()
      try {
        await expect(controller.probePtyLiveness(ptyId)).resolves.toBeNull()

        unregisterSshPtyProvider(connectionId)
        // A disconnected SSH provider is an error path, and errors never prove absence.
        await expect(controller.probePtyLiveness(ptyId)).resolves.toBeNull()
      } finally {
        unregisterSshPtyProvider(connectionId)
        clearPtyOwnershipForConnection(connectionId)
        clearProviderPtyState(ptyId)
      }
    })

    it('answers unknown for remote-scoped ids without consulting local providers', async () => {
      // Why: a locally routed provider would answer confidently — and wrongly —
      // for a PTY that lives on a remote Orca host.
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
    const sshProvider = createAgentClaimProvider({})
    setLocalPtyProvider(localProvider as never)
    registerSshPtyProvider('ssh-attach', sshProvider as never)
    const controller = registerAgentClaimController()
    const daemonPtyId = 'repo-1::/tmp/wt@@1a2b3c4d'
    const ownedSshPtyId = 'owned-remote-pty'
    setPtyOwnership(ownedSshPtyId, 'ssh-attach')
    try {
      // Local daemon session: attach flows to the provider.
      await expect(controller.attach(daemonPtyId)).resolves.toBe(true)
      expect(localProvider.attach).toHaveBeenCalledWith(daemonPtyId)

      // SSH-scoped sessions are excluded — leases handle their reattach.
      await expect(controller.attach(ownedSshPtyId)).resolves.toBe(false)
      await expect(controller.attach('ssh:ssh-attach@@relay-pty')).resolves.toBe(false)
      expect(sshProvider.attach).not.toHaveBeenCalled()

      // Provider refusal (absent/unprovable session) answers false, not throw.
      localProvider.attach.mockRejectedValueOnce(new Error('Session not found'))
      await expect(controller.attach(daemonPtyId)).resolves.toBe(false)

      // The in-process local provider streams without attach; never called.
      const inProcess = new LocalPtyProvider()
      const inProcessAttach = vi.spyOn(inProcess, 'attach')
      setLocalPtyProvider(inProcess)
      await expect(controller.attach(daemonPtyId)).resolves.toBe(false)
      expect(inProcessAttach).not.toHaveBeenCalled()
    } finally {
      unregisterSshPtyProvider('ssh-attach')
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
      'incarnation-canonical-exited'
    )
  })
  it('rejects renderer spawn publication when the provider reply proves exit', async () => {
    const connectionId = 'ssh-renderer-exited-reply'
    const appPtyId = `ssh:${connectionId}@@relay-pty`
    const provider = {
      spawn: vi.fn(async () => ({
        id: appPtyId,
        incarnationId: 'incarnation-renderer-exited',
        exitedBeforeSpawnReply: true as const
      })),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    }
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(),
      removeSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    }
    const runtime = {
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_renderer_exited'),
      preAllocateHandleForPty: vi.fn(() => 'term_renderer_exited'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    registerSshPtyProvider(connectionId, provider as never)
    try {
      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        undefined,
        store as never
      )
      const leafId = '33333333-3333-4333-8333-333333333333'

      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp/worktree',
          connectionId,
          worktreeId: 'repo::/tmp/worktree',
          tabId: 'tab-renderer-exited',
          leafId
        })
      ).rejects.toThrow('agent_session_exited_during_start')

      expect(runtime.registerPty).not.toHaveBeenCalled()
      expect(runtime.registerPreAllocatedHandleForPty).not.toHaveBeenCalled()
      expect(store.persistPtyBinding).not.toHaveBeenCalled()
      expect(store.upsertSshRemotePtyLease).not.toHaveBeenCalled()
      expect(getPtyIdsForConnection(connectionId)).toEqual([])
    } finally {
      unregisterSshPtyProvider(connectionId)
    }
  })
})
