import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { spawnMock } from './pty-ipc-mock-registry'
import { posixOnlyIt, TEST_MANAGED_ROOT } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { prepareCodexSessionResume } from '../codex/codex-session-resume-preparation'
import { registerPtyHandlers, setLocalPtyProvider, type PrepareCodexSessionResume } from './pty'

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

      // Why: main's real provenance rule via the same prepareCodexSessionResume that
      // index.ts calls, so the outcome wiring is exercised rather than restated. This
      // suite mocks fs, so the rollout is declared present — the only variable left is
      // whether its home is trusted, which is exactly the case the guard exists for.
      const prepareResumeWithTrustedHomes =
        (trustedHomes: readonly string[]): PrepareCodexSessionResume =>
        ({ providerSession }) =>
          prepareCodexSessionResume({
            sessionId: providerSession.id,
            transcriptPath: providerSession.transcriptPath,
            trustedCodexHomes: trustedHomes,
            // Why: these cases assert the argv drop, never the legacy rescan's home ranking
            // (#10801) — each passes a single trusted home, so no ranking can move the winner.
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

      /** A daemon-shaped provider: the only local path that reports reattach results and
       *  the only one that surfaces the resolved spawn options this guard rewrites. */
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
        'launches plain codex when a REAL rollout sits under a home Orca no longer trusts',
        async () => {
          // Why: the discriminating case — the rollout exists, so only the trust check can
          // reject it. Falling through would resume it under the selected account.
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

            expect(mockProc.proc.write).toHaveBeenCalledWith('codex\n')
            expect(mockProc.proc.write).not.toHaveBeenCalledWith(
              expect.stringContaining(RESUME_SESSION_ID)
            )
            expect(spawned.agentResumeUnavailable).toBe(true)
            // The pane still runs under the selected account — but with nothing to resume.
            const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
            expect(env.CODEX_HOME).toBe(OTHER_HOME)
            expect(selectedHome).toHaveBeenCalled()
          } finally {
            vi.useRealTimers()
          }
        }
      )
      it('reports the dropped resume so the pane can say it started fresh', async () => {
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
        const spawned = await spawnCodexResume(ORIGIN_ROLLOUT)

        expect(spawned.agentResumeUnavailable).toBe(true)
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

          expect(mockProc.proc.write).toHaveBeenCalledWith(
            `codex 'resume' '${RESUME_SESSION_ID}'\n`
          )
          expect(spawned.agentResumeUnavailable).toBeUndefined()
          const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
          expect(env.CODEX_HOME).toBe(ORIGIN_HOME)
          expect(selectedHome).not.toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
        }
      })
      posixOnlyIt('reports a dropped resume that carried no transcript path at all', async () => {
        // Why: legacy sleeping-agent and relay records persist only the session id. The
        // argv still gets stripped, so silence would leave an empty pane unexplained.
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

          expect(mockProc.proc.write).toHaveBeenCalledWith('codex\n')
          expect(spawned.agentResumeUnavailable).toBe(true)
        } finally {
          vi.useRealTimers()
        }
      })
      it('refuses an unstrippable resume whose metadata claimed Codex layout', async () => {
        // Why: the locator survives in the command, so launching could still cross accounts.
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

        await expect(
          spawnCodexResume(ORIGIN_ROLLOUT, {
            command: `codex 'resume' '${RESUME_SESSION_ID}' --sandbox`
          })
        ).rejects.toThrow(/could not verify the originating Codex session file/)
      })
      posixOnlyIt(
        'launches an unstrippable resume unchanged when metadata never claimed Codex layout',
        async () => {
          // Why: a pane mislabeled "codex" carrying ~/.claude metadata launched fine before
          // this guard existed; refusing its spawn would be a new hard failure.
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

            expect(mockProc.proc.write).toHaveBeenCalledWith(`${command}\n`)
            expect(spawned.agentResumeUnavailable).toBeUndefined()
          } finally {
            vi.useRealTimers()
          }
        }
      )
      it('strips the resume argv from the sequenced startup command too', async () => {
        // Why: buildPtyHostEnv prefers this env var over the launch command and the
        // sequenced wrapper `eval`s it, so leaving it intact resumes under the wrong account.
        const daemonSpawn = setupResumeDaemonProvider()
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

        await spawnCodexResume(ORIGIN_ROLLOUT, {
          env: { ORCA_SEQUENCED_STARTUP_COMMAND: `codex 'resume' '${RESUME_SESSION_ID}'` }
        })

        const spawnOptions = daemonSpawn.mock.calls.at(-1)![0]
        expect(spawnOptions.env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe('codex')
        expect(spawnOptions.command).toBe('codex')
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
      posixOnlyIt(
        'strips the sequenced startup command on the local-provider spawn path too',
        async () => {
          // Why: the daemon branch is the only one that re-derives the spawn env from
          // baseEnv, so a local spawn is where a strip that lands on the wrong variable
          // silently survives — and the wrapper would `eval` the resume anyway.
          const mockProc = createMockProc()
          spawnMock.mockReturnValue(mockProc.proc)
          registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

          await spawnCodexResume(ORIGIN_ROLLOUT, {
            env: { ORCA_SEQUENCED_STARTUP_COMMAND: `codex 'resume' '${RESUME_SESSION_ID}'` }
          })

          const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
          expect(env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe('codex')
        }
      )
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
      it('drops the resume argv on the runtime controller spawn path', async () => {
        // Why: the runtime/relay controller is a second spawn entry point; the invariant
        // has to hold there too even though it has no channel for the notice.
        const daemonSpawn = setupResumeDaemonProvider()
        const runtime = {
          setPtyController: vi.fn(),
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
        expect(spawnOptions.command).toBe('codex')
        expect(spawnOptions.env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe('codex')
        expect(runtime.noteTerminalSpawnCommand).toHaveBeenCalledWith(expect.any(String), 'codex')
      })
    })
  })
})
