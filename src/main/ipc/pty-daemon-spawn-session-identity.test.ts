import { describe, expect, it, vi } from 'vitest'
import {
  openCodeBuildPtyEnvMock,
  openCodeClearPtyMock,
  piBuildPtyEnvMock,
  piClearPtyMock
} from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { createDaemonActiveProviderFixtures } from './pty-ipc-daemon-provider-fixtures'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  registerPtyHandlers,
  registerSshPtyProvider,
  deletePtyOwnership,
  setPtyOwnership,
  setLocalPtyProvider
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
  const { handlers, mainWindow, recoveredAgentClaim, recoveredAgentSurface } = setupPtyIpcSuite()

  describe('spawn environment', () => {
    describe('daemon-active provider (parity with LocalPtyProvider)', () => {
      const { setupDaemonAdapter, daemonSpawnAndGetEnv } = createDaemonActiveProviderFixtures({
        handlers,
        mainWindow
      })

      // Why: under the daemon, LocalPtyProvider.buildSpawnEnv never runs, so host-local env injection must happen in the pty:spawn handler instead.
      it('materializes the full guard for a legacy daemon host', async () => {
        const env = await daemonSpawnAndGetEnv(
          {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.proxy',
            GIT_CONFIG_VALUE_0: 'http://proxy.invalid'
          },
          undefined,
          undefined,
          undefined,
          { command: 'claude' },
          false
        )

        expect(env.GIT_TERMINAL_PROMPT).toBe('0')
        expect(env.GCM_INTERACTIVE).toBe('never')
        expect(env.GIT_CONFIG_COUNT).toBe('3')
        expect(env.GIT_CONFIG_KEY_1).toBe('credential.interactive')
        expect(env.GIT_CONFIG_KEY_2).toBe('credential.guiPrompt')
      })
      it('passes the minted sessionId through to provider.spawn and host env setup', async () => {
        const daemonSpawn = setupDaemonAdapter()
        handlers.clear()
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          env: {}
        })
        const spawnOpts = daemonSpawn.mock.calls.at(-1)![0]
        const sessionId = spawnOpts.sessionId
        expect(sessionId).toEqual(expect.any(String))
        expect((sessionId ?? '').length).toBeGreaterThan(0)
        expect(spawnOpts.isNewSession).toBe(true)
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(sessionId, undefined, 'pi', {
          materializeDefaultHome: false
        })
      })
      it('respects a caller-provided sessionId instead of minting a new one', async () => {
        const daemonSpawn = setupDaemonAdapter()
        handlers.clear()
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          env: {},
          sessionId: 'user-session-42'
        })
        expect(daemonSpawn.mock.calls.at(-1)![0].sessionId).toBe('user-session-42')
        expect(daemonSpawn.mock.calls.at(-1)![0].isNewSession).toBeUndefined()
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith('user-session-42', undefined, 'pi', {
          materializeDefaultHome: false
        })
      })
      it('prefixes a minted sessionId with the worktreeId when provided', async () => {
        // Why: daemon reconnect keys live-shell survival on the sessionId; prefixing with worktreeId scopes sessions by worktree with a unique tail.
        const daemonSpawn = setupDaemonAdapter()
        handlers.clear()
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          env: {},
          worktreeId: 'wt-alpha'
        })
        const sessionId = daemonSpawn.mock.calls.at(-1)![0].sessionId ?? ''
        expect(sessionId).toMatch(/^wt-alpha@@[0-9a-f]{8}$/)
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(sessionId, undefined, 'pi', {
          materializeDefaultHome: false
        })
      })
      it('reuses one attach-style daemon session for fresh-agent operation retries', async () => {
        const daemonSpawn = setupDaemonAdapter()
        let controller:
          | { spawn: (args: Record<string, unknown>) => Promise<{ id: string }> }
          | undefined
        const runtime = {
          setPtyController: vi.fn((next) => {
            controller = next
          }),
          registerPreAllocatedHandleForPty: vi.fn(),
          registerPty: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
        const request = {
          cols: 80,
          rows: 24,
          env: {},
          worktreeId: 'wt-alpha',
          agentSessionCreateOperationId: 'a'.repeat(43)
        }

        await controller!.spawn(request)
        await controller!.spawn(request)

        const first = daemonSpawn.mock.calls.at(-2)?.[0]
        const second = daemonSpawn.mock.calls.at(-1)?.[0]
        expect(first?.sessionId).toBe('wt-alpha@@aaaaaaaa')
        expect(second?.sessionId).toBe(first?.sessionId)
        expect(first?.isNewSession).toBe(true)
        expect(second?.isNewSession).toBe(true)
        expect(first?.agentSessionCreateOperationId).toBe('a'.repeat(43))
        expect(second?.agentSessionCreateOperationId).toBe('a'.repeat(43))
      })
      it('does not downgrade a structured claim after dispatch reaches an old daemon', async () => {
        const daemonSpawn = setupDaemonAdapter(true, undefined, false)
        let controller:
          | { spawn: (args: Record<string, unknown>) => Promise<{ id: string }> }
          | undefined
        const runtime = {
          setPtyController: vi.fn((next) => {
            controller = next
          }),
          registerPreAllocatedHandleForPty: vi.fn(),
          registerPty: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)

        await expect(
          controller!.spawn({
            cols: 80,
            rows: 24,
            worktreeId: recoveredAgentSurface.worktreeId,
            tabId: recoveredAgentSurface.tabId,
            leafId: recoveredAgentSurface.leafId,
            command: "codex resume 'provider-session-1'",
            agentSessionEnsure: {
              claim: recoveredAgentClaim,
              surface: recoveredAgentSurface
            }
          })
        ).rejects.toThrow('agent_session_claim_unavailable')

        expect(daemonSpawn).not.toHaveBeenCalled()
      })
      it('falls back to process.env.PI_CODING_AGENT_DIR when baseEnv lacks it on the daemon path', async () => {
        // Why: buildPtyHostEnv reads `baseEnv.X ?? process.env.X` so the agent-dir guard works whether Pi's env came over IPC or via daemon fork.
        const env = await daemonSpawnAndGetEnv({}, undefined, undefined, {
          PI_CODING_AGENT_DIR: '/ambient/pi/agent'
        })
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
          expect.any(String),
          '/ambient/pi/agent',
          'pi',
          { materializeDefaultHome: false }
        )
        expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/ambient/pi/agent')
      })
      it('does not mutate the caller-provided args.env on the daemon path', async () => {
        // Why: the handler clones baseEnv so IPC-provided env stays pristine; a regression would leak Orca host env back into the renderer's reused copy.
        const daemonSpawn = setupDaemonAdapter()
        const argsEnv: Record<string, string> = { FOO: 'bar' }
        handlers.clear()
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          env: argsEnv
        })
        expect(argsEnv).toEqual({ FOO: 'bar' })
        // Sanity: the spawn did receive the injected env, so the test isn't passing vacuously.
        const spawnEnv = daemonSpawn.mock.calls.at(-1)![0].env
        expect(spawnEnv.ORCA_AGENT_HOOK_PORT).toBe('5678')
        expect(spawnEnv).not.toBe(argsEnv)
      })
      it('rejects a caller-supplied sessionId that escapes userData via ..', async () => {
        // Why: effectiveSessionId reaches filesystem side-effects, so a traversal payload must be refused before they run.
        const daemonSpawn = setupDaemonAdapter()
        handlers.clear()
        registerPtyHandlers(mainWindow as never)
        await expect(
          handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            env: {},
            sessionId: '../etc/passwd'
          })
        ).rejects.toThrow(/Invalid PTY session id/)
        expect(daemonSpawn).not.toHaveBeenCalled()
        expect(piBuildPtyEnvMock).not.toHaveBeenCalled()
      })
      it('sweeps per-PTY state when provider.spawn fails for a MINTED sessionId', async () => {
        // Why: buildPtyHostEnv has filesystem side-effects, so a minted id's per-PTY state must be cleared if provider.spawn later fails.
        const daemonSpawn = vi.fn(async () => {
          throw new Error('spawn boom')
        })
        setLocalPtyProvider({
          spawn: daemonSpawn,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          shutdown: vi.fn(),
          onData: vi.fn(() => vi.fn()),
          onExit: vi.fn(() => vi.fn()),
          listProcesses: vi.fn(async () => []),
          getForegroundProcess: vi.fn(async () => null)
        } as never)
        const runtime = {
          setPtyController: vi.fn(),
          createPreAllocatedTerminalHandle: vi.fn(() => null),
          preAllocateHandleForPty: vi.fn(),
          preparePtyExecutionContext: vi.fn().mockReturnValue(true)
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
        await expect(
          handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
        ).rejects.toThrow(/spawn boom/)
        expect(openCodeClearPtyMock).toHaveBeenCalled()
        expect(piClearPtyMock).toHaveBeenCalled()
        expect(runtime.preparePtyExecutionContext).toHaveBeenLastCalledWith(
          expect.any(String),
          null,
          { resetIncarnation: true }
        )
      })
      it('does NOT sweep per-PTY state on provider.spawn failure for CALLER-supplied sessionId', async () => {
        // Why: a caller-supplied sessionId may refer to an existing PTY whose state must survive a retry/attach failure; only minted ids get swept.
        const daemonSpawn = vi.fn(async () => {
          throw new Error('spawn boom')
        })
        setLocalPtyProvider({
          spawn: daemonSpawn,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          shutdown: vi.fn(),
          onData: vi.fn(() => vi.fn()),
          onExit: vi.fn(() => vi.fn()),
          listProcesses: vi.fn(async () => []),
          getForegroundProcess: vi.fn(async () => null)
        } as never)
        const runtime = {
          setPtyController: vi.fn(),
          createPreAllocatedTerminalHandle: vi.fn(() => null),
          preAllocateHandleForPty: vi.fn(),
          preparePtyExecutionContext: vi.fn().mockReturnValue(true)
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
        await expect(
          handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            env: {},
            sessionId: 'caller-owned-session'
          })
        ).rejects.toThrow(/spawn boom/)
        expect(openCodeClearPtyMock).not.toHaveBeenCalled()
        expect(piClearPtyMock).not.toHaveBeenCalled()
        expect(runtime.preparePtyExecutionContext).toHaveBeenLastCalledWith(
          'caller-owned-session',
          null,
          { resetIncarnation: true }
        )
      })
      it('does NOT inject host-local env on SSH spawns (connectionId set)', async () => {
        const sshSpawn = vi.fn(
          async (_opts: {
            env: Record<string, string>
            envToDelete?: string[]
            paneKey?: string
            tabId?: string
          }) => ({
            id: 'ssh-pty'
          })
        )
        const store = {
          upsertSshRemotePtyLease: vi.fn(),
          persistPtyBinding: vi.fn()
        }
        registerSshPtyProvider('ssh-1', {
          spawn: sshSpawn,
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
        } as never)
        handlers.clear()
        registerPtyHandlers(
          mainWindow as never,
          undefined,
          undefined,
          (() => ({
            httpProxyUrl: 'http://proxy.example:8080',
            httpProxyBypassRules: 'localhost',
            codexSystemDefaultRealHomeEnabled: true
          })) as never,
          undefined,
          store as never
        )
        const leafId = '11111111-1111-4111-8111-111111111111'
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          env: { FOO: 'bar', ORCA_PANE_KEY: makePaneKey('tab-1', leafId) },
          connectionId: 'ssh-1',
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId
        })
        const spawnOptions = sshSpawn.mock.calls.at(-1)![0]
        const env = spawnOptions.env
        // Why: host-local vars must be absent over SSH (they point at the local host/disk) — shipping them is useless or a credential leak.
        expect(env.ORCA_AGENT_HOOK_PORT).toBeUndefined()
        expect(env.ORCA_AGENT_HOOK_TOKEN).toBeUndefined()
        expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
        expect(env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
        expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
        expect(env.MIMOCODE_HOME).toBeUndefined()
        expect(env.ORCA_MIMOCODE_HOME).toBeUndefined()
        expect(env.ORCA_MIMOCODE_SOURCE_HOME).toBeUndefined()
        expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
        expect(env.CODEX_HOME).toBeUndefined()
        expect(env.HTTP_PROXY).toBeUndefined()
        expect(env.HTTPS_PROXY).toBeUndefined()
        expect(env.NO_PROXY).toBeUndefined()
        expect(env.FOO).toBe('bar')
        // Why: real-home routing is host-only. A null local-home resolver on
        // SSH must not become a request to alter the remote Codex environment.
        expect(spawnOptions.envToDelete ?? []).not.toContain('CODEX_HOME')
        expect(spawnOptions.envToDelete ?? []).not.toContain('ORCA_CODEX_HOME')
        expect(spawnOptions.paneKey).toBe(makePaneKey('tab-1', leafId))
        expect(spawnOptions.tabId).toBe('tab-1')
        expect(openCodeBuildPtyEnvMock).not.toHaveBeenCalled()
        expect(piBuildPtyEnvMock).not.toHaveBeenCalled()
        expect(store.upsertSshRemotePtyLease).toHaveBeenCalledWith(
          expect.objectContaining({
            targetId: 'ssh-1',
            ptyId: 'ssh-pty',
            worktreeId: 'wt-1',
            tabId: 'tab-1',
            leafId,
            state: 'attached'
          })
        )
        expect(store.persistPtyBinding).toHaveBeenCalledWith(
          {
            worktreeId: 'wt-1',
            tabId: 'tab-1',
            leafId,
            ptyId: 'ssh-pty'
          },
          'ssh:ssh-1'
        )

        store.upsertSshRemotePtyLease.mockClear()
        store.persistPtyBinding.mockClear()
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          env: { ORCA_PANE_KEY: 'tab-1:pane:1' },
          connectionId: 'ssh-1',
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId: 'pane:1'
        })
        expect(store.upsertSshRemotePtyLease).toHaveBeenCalledTimes(1)
        const legacySpawnOptions = sshSpawn.mock.calls.at(-1)?.[0]
        expect(legacySpawnOptions?.env.ORCA_PANE_KEY).toBeUndefined()
        expect(legacySpawnOptions?.paneKey).toBeUndefined()
        expect(legacySpawnOptions?.tabId).toBe('tab-1')
        expect(store.upsertSshRemotePtyLease.mock.calls[0]?.[0]).not.toHaveProperty('leafId')
        expect(store.persistPtyBinding).not.toHaveBeenCalled()
      })
      it('marks a caller-supplied SSH session expired when remote reattach is gone', async () => {
        const sshSpawn = vi.fn(async () => {
          throw new Error('SSH_SESSION_EXPIRED: remote-pty')
        })
        const store = {
          markSshRemotePtyLease: vi.fn()
        }
        registerSshPtyProvider('ssh-1', {
          spawn: sshSpawn,
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
        } as never)
        handlers.clear()
        registerPtyHandlers(
          mainWindow as never,
          undefined,
          undefined,
          undefined,
          undefined,
          store as never
        )

        await expect(
          handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            env: {},
            connectionId: 'ssh-1',
            sessionId: 'remote-pty'
          })
        ).rejects.toThrow('SSH_SESSION_EXPIRED: remote-pty')

        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'remote-pty', 'expired')
      })
      it('marks a scoped SSH session expired using the raw relay lease id', async () => {
        const scopedPtyId = 'ssh:ssh-1@@remote-pty'
        const sshSpawn = vi.fn(async () => {
          throw new Error('SSH_SESSION_EXPIRED: remote-pty')
        })
        const store = {
          markSshRemotePtyLease: vi.fn()
        }
        registerSshPtyProvider('ssh-1', {
          spawn: sshSpawn,
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
        } as never)
        setPtyOwnership(scopedPtyId, 'ssh-1')
        handlers.clear()
        registerPtyHandlers(
          mainWindow as never,
          undefined,
          undefined,
          undefined,
          undefined,
          store as never
        )

        try {
          await expect(
            handlers.get('pty:spawn')!(null, {
              cols: 80,
              rows: 24,
              env: {},
              connectionId: 'ssh-1',
              sessionId: scopedPtyId
            })
          ).rejects.toThrow('SSH_SESSION_EXPIRED: remote-pty')
        } finally {
          deletePtyOwnership(scopedPtyId)
        }

        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'remote-pty', 'expired')
        expect(openCodeClearPtyMock).toHaveBeenCalledWith(scopedPtyId)
        expect(piClearPtyMock).toHaveBeenCalledWith(scopedPtyId)
      })
    })
  })
})
