import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { spawnMock, noChatsRuntimeMembers } from './pty-ipc-mock-registry'
import { posixOnlyIt, TEST_MANAGED_ROOT } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { prepareCodexSessionResume } from '../../codex/codex-session-resume-preparation'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from '../../pty/posix-shell-startup-command'
import { registerPtyHandlers } from './register-handlers'
import { setLocalPtyProvider } from './provider/registry'
import type { PrepareCodexSessionResume } from './host-env/types'

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
  const { handlers, mainWindow, createMockProc } = setupPtyIpcSuite()

  describe('spawn environment', () => {
    describe('unverifiable Codex resume provenance', () => {
      const RESUME_SESSION_ID = '019f81b9-19a9-7651-a8d1-352d9420bd11'
      const ORIGIN_HOME = join(TEST_MANAGED_ROOT, 'origin', 'home')
      const OTHER_HOME = join(TEST_MANAGED_ROOT, 'other', 'home')
      const ORIGIN_ROLLOUT = join(
        ORIGIN_HOME,
        'sessions',
        '2026',
        '07',
        '20',
        `rollout-2026-07-20T12-00-00-${RESUME_SESSION_ID}.jsonl`
      )

      // Use real resume preparation with a present rollout; trust is the only rejection variable.
      const prepareResumeWithTrustedHomes =
        (trustedHomes: readonly string[]): PrepareCodexSessionResume =>
        ({ providerSession }) =>
          prepareCodexSessionResume({
            sessionId: providerSession.id,
            transcriptPath: providerSession.transcriptPath,
            trustedCodexHomes: trustedHomes,
            // One trusted home removes legacy rescan ranking from these resume-routing cases (#10801).
            getSelectedAccountCodexHome: () => null,
            systemCodexHomePath: null,
            sharedRuntimeCodexHomePath: null,
            fileIsRegular: () => true,
            resolveVerifiedResumeHome: async (source) => source.homePath
          })

      function registerWithTrustedHomes(trustedHomes: readonly string[], selectedHome: string) {
        const selectedHomeMock = vi.fn(() => selectedHome)
        registerPtyHandlers(
          mainWindow as never,
          undefined,
          selectedHomeMock,
          undefined,
          undefined,
          undefined,
          { prepareCodexSessionResume: prepareResumeWithTrustedHomes(trustedHomes) }
        )
        return selectedHomeMock
      }

      async function spawnCodexResume(
        transcriptPath: string | undefined,
        overrides: { command?: string; env?: Record<string, string> } = {}
      ): Promise<{ agentResumeUnavailable?: true }> {
        return (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp',
          command: overrides.command ?? `codex 'resume' '${RESUME_SESSION_ID}'`,
          ...(overrides.env ? { env: overrides.env } : {}),
          launchAgent: 'codex',
          resumeProviderSession: {
            key: 'session_id',
            id: RESUME_SESSION_ID,
            ...(transcriptPath ? { transcriptPath } : {})
          }
        })) as { agentResumeUnavailable?: true }
      }

      /** Daemon-shaped provider exposes the actual command, environment and reattach result. */
      function setupResumeDaemonProvider(spawnResult: { isReattach?: true } = {}) {
        const daemonSpawn = vi.fn(
          async (options: {
            sessionId?: string
            command?: string
            env: Record<string, string>
          }) => {
            void options
            return { id: options.sessionId ?? 'daemon-pty', ...spawnResult }
          }
        )
        setLocalPtyProvider({
          spawn: daemonSpawn,
          supportsGitCredentialGuardHost: () => true,
          supportsAgentSessionClaims: () => true,
          supportsAgentSessionCreateOperations: () => true,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          shutdown: vi.fn(),
          onData: vi.fn(() => vi.fn()),
          onExit: vi.fn(() => vi.fn()),
          listProcesses: vi.fn(async () => []),
          getForegroundProcess: vi.fn(async () => null)
        } as never)
        return daemonSpawn
      }

      posixOnlyIt(
        'preserves the requested Codex resume when its rollout home is no longer trusted',
        async () => {
          // The rollout exists; only provenance trust can reject cross-account resume.
          const mockProc = createMockProc()
          spawnMock.mockReturnValue(mockProc.proc)
          vi.useFakeTimers()

          try {
            const selectedHome = registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
            const spawned = await spawnCodexResume(ORIGIN_ROLLOUT)

            await Promise.resolve()
            vi.runAllTimers()
            await Promise.resolve()
            vi.runAllTimers()

            expect(mockProc.proc.write).not.toHaveBeenCalled()
            expect(mockProc.proc.write).not.toHaveBeenCalledWith(
              expect.stringContaining(RESUME_SESSION_ID)
            )
            expect(spawned.agentResumeUnavailable).toBeUndefined()
            const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
            expect(env.CODEX_HOME).toBe(OTHER_HOME)
            expect(env[POSIX_SHELL_STARTUP_COMMAND_ENV]).toBe(
              `codex 'resume' '${RESUME_SESSION_ID}'`
            )
            expect(selectedHome).toHaveBeenCalled()
          } finally {
            vi.useRealTimers()
          }
        }
      )
      it('preserves the requested session identity in the IPC result', async () => {
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
        const spawned = await spawnCodexResume(ORIGIN_ROLLOUT)

        expect(spawned).toMatchObject({
          resumeProviderSession: {
            key: 'session_id',
            id: RESUME_SESSION_ID,
            transcriptPath: ORIGIN_ROLLOUT
          }
        })
      })
      it('stays silent for cross-agent provenance on a pane relabeled codex', async () => {
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

        const spawned = await spawnCodexResume(
          '/Users/example/.claude/projects/repo/019f81b9.jsonl'
        )

        expect(spawned.agentResumeUnavailable).toBeUndefined()
      })
      posixOnlyIt('still pins CODEX_HOME and resumes when provenance is verified', async () => {
        const mockProc = createMockProc()
        spawnMock.mockReturnValue(mockProc.proc)
        vi.useFakeTimers()

        try {
          const selectedHome = registerWithTrustedHomes([ORIGIN_HOME], OTHER_HOME)
          const spawned = await spawnCodexResume(ORIGIN_ROLLOUT)

          await Promise.resolve()
          vi.runAllTimers()
          await Promise.resolve()
          vi.runAllTimers()

          expect(mockProc.proc.write).not.toHaveBeenCalled()
          expect(spawned.agentResumeUnavailable).toBeUndefined()
          const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
          expect(env.CODEX_HOME).toBe(ORIGIN_HOME)
          expect(env[POSIX_SHELL_STARTUP_COMMAND_ENV]).toBe(`codex 'resume' '${RESUME_SESSION_ID}'`)
          expect(selectedHome).not.toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
        }
      })
      posixOnlyIt('preserves a legacy resume that carried no transcript path', async () => {
        // Legacy records can rely on Codex ID lookup without a saved transcript path.
        const mockProc = createMockProc()
        spawnMock.mockReturnValue(mockProc.proc)
        vi.useFakeTimers()

        try {
          registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
          const spawned = await spawnCodexResume(undefined)

          await Promise.resolve()
          vi.runAllTimers()
          await Promise.resolve()
          vi.runAllTimers()

          expect(mockProc.proc.write).not.toHaveBeenCalled()
          const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
          expect(env[POSIX_SHELL_STARTUP_COMMAND_ENV]).toBe(`codex 'resume' '${RESUME_SESSION_ID}'`)
          expect(spawned.agentResumeUnavailable).toBeUndefined()
        } finally {
          vi.useRealTimers()
        }
      })
      it('launches a resume with trailing flags unchanged instead of refusing before spawn', async () => {
        const daemonSpawn = setupResumeDaemonProvider()
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
        const command = `codex 'resume' '${RESUME_SESSION_ID}' --sandbox workspace-write`

        const spawned = await spawnCodexResume(ORIGIN_ROLLOUT, { command })

        expect(daemonSpawn).toHaveBeenCalledOnce()
        expect(daemonSpawn.mock.calls[0][0].command).toBe(command)
        expect(spawned.agentResumeUnavailable).toBeUndefined()
      })
      posixOnlyIt('preserves shell commands carrying metadata from another agent', async () => {
        // Other-agent metadata must not turn a mislabeled Codex pane into a new hard failure.
        const mockProc = createMockProc()
        spawnMock.mockReturnValue(mockProc.proc)
        vi.useFakeTimers()

        try {
          registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
          const command = `cd '/tmp/${RESUME_SESSION_ID}' && codex 'resume' '${RESUME_SESSION_ID}'`
          const spawned = await spawnCodexResume('/Users/example/.claude/projects/repo/x.jsonl', {
            command
          })

          await Promise.resolve()
          vi.runAllTimers()
          await Promise.resolve()
          vi.runAllTimers()

          expect(mockProc.proc.write).toHaveBeenCalledWith(`${command}\r`)
          expect(spawned.agentResumeUnavailable).toBeUndefined()
        } finally {
          vi.useRealTimers()
        }
      })
      it('preserves resume arguments in the sequenced startup command', async () => {
        // The wrapper executes this environment command instead of the ordinary launch command.
        const daemonSpawn = setupResumeDaemonProvider()
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

        await spawnCodexResume(ORIGIN_ROLLOUT, {
          env: { ORCA_SEQUENCED_STARTUP_COMMAND: `codex 'resume' '${RESUME_SESSION_ID}'` }
        })

        const spawnOptions = daemonSpawn.mock.calls.at(-1)![0]
        expect(spawnOptions.env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe(
          `codex 'resume' '${RESUME_SESSION_ID}'`
        )
        expect(spawnOptions.command).toBe(`codex 'resume' '${RESUME_SESSION_ID}'`)
      })
      it('leaves the sequenced startup command alone when provenance is verified', async () => {
        const daemonSpawn = setupResumeDaemonProvider()
        registerWithTrustedHomes([ORIGIN_HOME], OTHER_HOME)
        const sequenced = `codex 'resume' '${RESUME_SESSION_ID}'`

        await spawnCodexResume(ORIGIN_ROLLOUT, {
          env: { ORCA_SEQUENCED_STARTUP_COMMAND: sequenced }
        })

        expect(daemonSpawn.mock.calls.at(-1)![0].env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe(sequenced)
      })
      posixOnlyIt('preserves sequenced startup on the local-provider path', async () => {
        // Local spawning uses the same caller environment as daemon spawning.
        const mockProc = createMockProc()
        spawnMock.mockReturnValue(mockProc.proc)
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

        await spawnCodexResume(ORIGIN_ROLLOUT, {
          env: { ORCA_SEQUENCED_STARTUP_COMMAND: `codex 'resume' '${RESUME_SESSION_ID}'` }
        })

        const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
        expect(env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe(`codex 'resume' '${RESUME_SESSION_ID}'`)
      })
      posixOnlyIt(
        'leaves the local-provider sequenced startup command alone when provenance is verified',
        async () => {
          const mockProc = createMockProc()
          spawnMock.mockReturnValue(mockProc.proc)
          registerWithTrustedHomes([ORIGIN_HOME], OTHER_HOME)
          const sequenced = `codex 'resume' '${RESUME_SESSION_ID}'`

          await spawnCodexResume(ORIGIN_ROLLOUT, {
            env: { ORCA_SEQUENCED_STARTUP_COMMAND: sequenced }
          })

          const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
          expect(env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe(sequenced)
        }
      )
      it('omits the notice on a reattach that never ran this launch command', async () => {
        setupResumeDaemonProvider({ isReattach: true })
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

        const spawned = await spawnCodexResume(ORIGIN_ROLLOUT)

        expect(spawned.agentResumeUnavailable).toBeUndefined()
      })
      it('preserves the resume command and sequenced startup on the runtime controller path', async () => {
        // Both spawn entry points must carry the same requested conversation to the provider.
        const daemonSpawn = setupResumeDaemonProvider()
        const runtime = {
          setPtyController: vi.fn(),
          ...noChatsRuntimeMembers(),
          registerPty: vi.fn(),
          noteTerminalSpawnCommand: vi.fn(),
          onPtySpawned: vi.fn(),
          onPtyExit: vi.fn(),
          onPtyData: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(
          mainWindow as never,
          runtime as never,
          vi.fn(() => OTHER_HOME),
          undefined,
          undefined,
          undefined,
          { prepareCodexSessionResume: prepareResumeWithTrustedHomes([OTHER_HOME]) }
        )
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          spawn(args: Record<string, unknown>): Promise<{ id: string }>
        }

        await controller.spawn({
          cols: 80,
          rows: 24,
          command: `codex 'resume' '${RESUME_SESSION_ID}'`,
          env: { ORCA_SEQUENCED_STARTUP_COMMAND: `codex 'resume' '${RESUME_SESSION_ID}'` },
          launchAgent: 'codex',
          resumeProviderSession: {
            key: 'session_id',
            id: RESUME_SESSION_ID,
            transcriptPath: ORIGIN_ROLLOUT
          }
        })

        const spawnOptions = daemonSpawn.mock.calls.at(-1)![0]
        expect(spawnOptions.command).toBe(`codex 'resume' '${RESUME_SESSION_ID}'`)
        expect(spawnOptions.env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe(
          `codex 'resume' '${RESUME_SESSION_ID}'`
        )
        expect(runtime.noteTerminalSpawnCommand).toHaveBeenCalledWith(
          expect.any(String),
          `codex 'resume' '${RESUME_SESSION_ID}'`
        )
      })
    })
  })
})
