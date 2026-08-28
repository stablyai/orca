import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import {
  registerSshPtyProvider,
  clearPtyOwnershipForConnection,
  clearProviderPtyState,
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
    createAgentClaimProvider,
    recoveredAgentClaim,
    recoveredAgentSurface,
    registerAgentClaimController
  } = setupPtyIpcSuite()

  it('fails closed without spawning when a recovered owner provider disconnects', async () => {
    const connectionId = 'ssh-agent-owner-gone'
    const ownerPtyId = `ssh:${connectionId}@@relay-owner`
    const claim = {
      ...recoveredAgentClaim,
      identityDigest: 'ccccccccccccccccccccccccccccccccccccccccccc'
    }
    const owner: AgentSessionOwnerBinding = {
      claim,
      generation: 'generation-remote',
      phase: 'live',
      ptyId: ownerPtyId,
      surface: recoveredAgentSurface
    }
    const remoteProvider = createAgentClaimProvider({
      sessions: [
        {
          id: ownerPtyId,
          incarnationId: 'incarnation-remote',
          cwd: '/tmp/recovered-worktree',
          title: 'Codex',
          agentSessionOwners: [owner]
        }
      ],
      livePtyIds: new Set([ownerPtyId])
    })
    registerSshPtyProvider(connectionId, remoteProvider as never)
    setLocalPtyProvider(createAgentClaimProvider({}) as never)
    const controller = registerAgentClaimController()

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        agentSessionEnsure: { claim, surface: recoveredAgentSurface }
      })
    ).resolves.toMatchObject({ id: ownerPtyId })

    unregisterSshPtyProvider(connectionId)
    const localSpawn = vi.fn(async () => ({ id: 'must-not-spawn' }))
    setLocalPtyProvider(createAgentClaimProvider({ spawn: localSpawn }) as never)

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        agentSessionEnsure: { claim, surface: recoveredAgentSurface }
      })
    ).rejects.toThrow('execution_owner_unavailable')
    expect(localSpawn).not.toHaveBeenCalled()
    clearProviderPtyState(ownerPtyId)
  })
  it('fails closed when provider listings disagree about a recovered claim owner', async () => {
    const claim = {
      ...recoveredAgentClaim,
      identityDigest: 'ddddddddddddddddddddddddddddddddddddddddddd'
    }
    const localOwner: AgentSessionOwnerBinding = {
      claim,
      generation: 'generation-conflict',
      phase: 'live',
      ptyId: 'pty-conflict-local',
      surface: recoveredAgentSurface
    }
    const remoteOwner: AgentSessionOwnerBinding = {
      ...localOwner,
      ptyId: 'ssh:ssh-agent-conflict@@pty-conflict-remote'
    }
    const localSpawn = vi.fn(async () => ({ id: 'must-not-spawn' }))
    setLocalPtyProvider(
      createAgentClaimProvider({
        sessions: [
          {
            id: localOwner.ptyId,
            incarnationId: 'incarnation-conflict-local',
            cwd: '/tmp/recovered-worktree',
            title: 'Codex',
            agentSessionOwners: [localOwner]
          }
        ],
        spawn: localSpawn
      }) as never
    )
    registerSshPtyProvider(
      'ssh-agent-conflict',
      createAgentClaimProvider({
        sessions: [
          {
            id: remoteOwner.ptyId,
            incarnationId: 'incarnation-conflict-remote',
            cwd: '/tmp/recovered-worktree',
            title: 'Codex',
            agentSessionOwners: [remoteOwner]
          }
        ]
      }) as never
    )
    const controller = registerAgentClaimController()

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        agentSessionEnsure: { claim, surface: recoveredAgentSurface }
      })
    ).rejects.toThrow('agent_session_conflict')
    expect(localSpawn).not.toHaveBeenCalled()

    unregisterSshPtyProvider('ssh-agent-conflict')
    clearProviderPtyState(localOwner.ptyId)
    clearProviderPtyState(remoteOwner.ptyId)
  })
  it('converges after conflicting listings shrink to one exact owner', async () => {
    const claim = {
      ...recoveredAgentClaim,
      identityDigest: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    }
    const ownerA: AgentSessionOwnerBinding = {
      claim,
      generation: 'generation-a',
      phase: 'live',
      ptyId: 'pty-conflict-a',
      surface: recoveredAgentSurface
    }
    const ownerB: AgentSessionOwnerBinding = {
      ...ownerA,
      generation: 'generation-b',
      ptyId: 'ssh:ssh-agent-converge@@pty-conflict-b'
    }
    const localSessions = [
      {
        id: ownerA.ptyId,
        incarnationId: 'incarnation-conflict-a',
        cwd: '/tmp/recovered-worktree',
        title: 'Codex',
        agentSessionOwners: [ownerA]
      }
    ]
    const remoteSessions = [
      {
        id: ownerB.ptyId,
        incarnationId: 'incarnation-conflict-b',
        cwd: '/tmp/recovered-worktree',
        title: 'Codex',
        agentSessionOwners: [ownerB]
      }
    ]
    const local = createAgentClaimProvider({ sessions: localSessions })
    setLocalPtyProvider(local as never)
    registerSshPtyProvider(
      'ssh-agent-converge',
      createAgentClaimProvider({ sessions: remoteSessions }) as never
    )
    const controller = registerAgentClaimController()
    const request = {
      cols: 80,
      rows: 24,
      cwd: '/tmp/recovered-worktree',
      agentSessionEnsure: { claim, surface: recoveredAgentSurface }
    }

    await expect(controller.spawn(request)).rejects.toThrow('agent_session_conflict')
    localSessions.splice(0)
    await expect(controller.spawn(request)).resolves.toMatchObject({
      id: ownerB.ptyId,
      agentSessionEnsure: { disposition: 'adopted', owner: ownerB }
    })
    expect(local.spawn).not.toHaveBeenCalled()

    unregisterSshPtyProvider('ssh-agent-converge')
    clearProviderPtyState(ownerA.ptyId)
    clearProviderPtyState(ownerB.ptyId)
  })
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
  it('preserves an owner fence across disconnect and adopts it after reconnect', async () => {
    const connectionId = 'ssh-agent-reconnect'
    const claim = {
      ...recoveredAgentClaim,
      identityDigest: '9999999999999999999999999999999999999999999'
    }
    const owner: AgentSessionOwnerBinding = {
      claim,
      generation: 'generation-reconnect',
      phase: 'live',
      ptyId: `ssh:${connectionId}@@pty-owner`,
      surface: recoveredAgentSurface
    }
    const sessions = [
      {
        id: owner.ptyId,
        incarnationId: 'incarnation-reconnect',
        cwd: '/tmp/recovered-worktree',
        title: 'Codex',
        agentSessionOwners: [owner]
      }
    ]
    const firstProvider = createAgentClaimProvider({ sessions })
    setLocalPtyProvider(createAgentClaimProvider({}) as never)
    registerSshPtyProvider(connectionId, firstProvider as never)
    const controller = registerAgentClaimController()
    const request = {
      cols: 80,
      rows: 24,
      cwd: '/tmp/recovered-worktree',
      connectionId,
      agentSessionEnsure: { claim, surface: recoveredAgentSurface }
    }

    await expect(controller.spawn(request)).resolves.toMatchObject({ id: owner.ptyId })
    unregisterSshPtyProvider(connectionId)
    clearPtyOwnershipForConnection(connectionId)
    await expect(controller.spawn({ ...request, connectionId: undefined })).rejects.toThrow(
      'execution_owner_unavailable'
    )

    const reconnected = createAgentClaimProvider({ sessions })
    registerSshPtyProvider(connectionId, reconnected as never)
    await expect(controller.spawn(request)).resolves.toMatchObject({
      id: owner.ptyId,
      agentSessionEnsure: { disposition: 'adopted', owner }
    })
    expect(reconnected.spawn).not.toHaveBeenCalled()

    unregisterSshPtyProvider(connectionId)
    clearProviderPtyState(owner.ptyId)
  })
})
