import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import type { AgentSessionOwnerBinding } from '../../../shared/agent-session/agent-session-host-authority'
import { registerPtyHandlers } from './register-handlers'
import { clearProviderPtyState } from './provider/state-cleanup'
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
vi.mock('../../agent-hooks/server/agent-hook-server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pty/shell-startup/pwsh', () =>
  import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../../wsl/filesystem/unc-path-access', async (importOriginal) =>
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
vi.mock('../../agent-hooks/observations/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/configuration/homes/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/history/index/codex-state-db-backfill-recovery', () =>
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
      notePtyInput: vi.fn(),
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
