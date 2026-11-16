import { classifyErrorMock } from './pty-ipc-mock-registry'
import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import type { AgentSessionOwnerBinding } from '../../../shared/agent-session/agent-session-host-authority'
import { setLocalPtyProvider } from './provider/registry'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/status-hooks/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server/agent-hook-server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/managed-extensions/titlebar-extension-service', () =>
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
vi.mock('../../cli/launchers/linux-terminal-orca-cli-shim', () =>
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
    handlers,
    mainWindowIpcEvent,
    createAgentClaimProvider,
    recoveredAgentClaim,
    recoveredAgentSurface,
    registerAgentClaimController
  } = setupPtyIpcSuite()

  it.each(['runtime', 'ipc', 'claim'] as const)(
    'gates a fresh %s launch at physical dispatch and binds the returned identity',
    async (entry) => {
      classifyErrorMock.mockReturnValue({ error_class: 'unknown' })
      let sent: { command?: string; env?: Record<string, string>; sessionId?: string } | undefined
      let bound: string | undefined
      const provider = createAgentClaimProvider({
        livePtyIds: new Set(['pty-physical-result']),
        authoritativeOwnerListings: false,
        sessions: [
          {
            id: 'pty-physical-result',
            incarnationId: 'physical-incarnation',
            cwd: '/tmp/recovered-worktree',
            title: 'Claude'
          }
        ],
        spawn: vi.fn(async (options) => {
          sent = options
          return { id: 'pty-physical-result', incarnationId: 'physical-incarnation' }
        })
      })
      setLocalPtyProvider(provider as never)
      const controller = registerAgentClaimController({
        prepareTerminalSetupForSpawn: async (request: { command?: string }) => ({
          command: 'wait-for-required-setup',
          env: { ORCA_SEQUENCED_STARTUP_COMMAND: request.command },
          bind: (id: string) => {
            bound = id
            return () => {}
          }
        })
      })
      const args = {
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        worktreeId: recoveredAgentSurface.worktreeId,
        command: 'claude --model selected-model',
        env: { KEEP_CALLER_VALUE: 'value', ORCA_SEQUENCED_STARTUP_COMMAND: 'forged' },
        ...(entry === 'claim'
          ? {
              agentSessionEnsure: {
                claim: { ...recoveredAgentClaim, agent: 'claude' },
                surface: recoveredAgentSurface
              }
            }
          : {})
      }
      const result =
        entry === 'ipc'
          ? await handlers.get('pty:spawn')!(mainWindowIpcEvent, args)
          : await controller.spawn(args)
      expect(result).toMatchObject({ id: 'pty-physical-result' })
      expect(sent?.command).toBe('wait-for-required-setup')
      expect(sent?.env).toMatchObject({
        KEEP_CALLER_VALUE: 'value',
        ORCA_SEQUENCED_STARTUP_COMMAND: 'claude --model selected-model'
      })
      expect(bound).toBe('pty-physical-result')
    }
  )

  it('reattaches a live caller-named PTY after a newer required Setup failed', async () => {
    const provider = createAgentClaimProvider({
      spawn: vi.fn(async (options) => {
        if (!options.attachOnly) {
          throw new Error('attach-only expected')
        }
        return { id: 'existing-live', isReattach: true }
      })
    })
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController({
      seedHeadlessTerminal: vi.fn(),
      prepareTerminalSetupForSpawn: async () => {
        throw new Error('Setup failed')
      }
    })
    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        worktreeId: recoveredAgentSurface.worktreeId,
        sessionId: 'existing-live',
        command: 'claude'
      })
    ).resolves.toMatchObject({ id: 'existing-live', isReattach: true })
  })

  it.each([
    { sessionId: '1', command: 'claude' },
    { sessionId: 'saved-shell', command: undefined }
  ])('keeps fresh restore semantics for $sessionId', async (request) => {
    const provider = createAgentClaimProvider({
      spawn: vi.fn(async (options) =>
        options.attachOnly
          ? { id: request.sessionId, isReattach: true }
          : { id: 'fresh-restored-shell' }
      )
    })
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController({ seedHeadlessTerminal: vi.fn() })
    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        worktreeId: recoveredAgentSurface.worktreeId,
        ...request
      })
    ).resolves.toMatchObject({ id: 'fresh-restored-shell' })
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
