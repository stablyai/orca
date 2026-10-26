import { describe, expect, it, vi } from 'vitest'
import { openCodeClearPtyMock, piBuildPtyEnvMock, piClearPtyMock } from '../pty-ipc-mock-registry'
import { awaitExplicitAgentPluginGuestReadiness } from '../../agent-hooks/wsl-agent-plugin-readiness'
import { setupPtyIpcSuite } from '../pty-ipc-test-harness'
import { createDaemonActiveProviderFixtures } from '../pty-ipc-daemon-provider-fixtures'
import { registerPtyHandlers } from './register-handlers'
import { setLocalPtyProvider } from './provider/registry'
import {
  buildJcodeRuntimeDir,
  JCODE_RUNTIME_DIR_ENV_KEY,
  shouldInjectJcodeRuntimeDir
} from '../../../shared/jcode-runtime-dir'

vi.mock('electron', () => import('../pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('../pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('../pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('../pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('../pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('../pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('../pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('../pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('../pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('../pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('../pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('../pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('../pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)
vi.mock('../../agent-hooks/wsl-agent-plugin-readiness', () => ({
  awaitExplicitAgentPluginGuestReadiness: vi.fn(async () => true)
}))

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, recoveredAgentClaim, recoveredAgentSurface } = setupPtyIpcSuite()

  describe('spawn environment', () => {
    describe('daemon-active provider (parity with LocalPtyProvider)', () => {
      const { setupDaemonAdapter, daemonSpawnAndGetEnv } = createDaemonActiveProviderFixtures({
        handlers,
        mainWindow
      })

      // Daemon spawns bypass LocalPtyProvider.buildSpawnEnv; main must inject host-local environment.
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
        // Scope daemon reconnect identity by worktree while retaining a unique session tail.
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
        // Ambient Pi configuration must receive the same guard as explicit IPC environment.
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
        // Host injection must not mutate a renderer's reusable environment object.
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
        const spawnEnv = daemonSpawn.mock.calls.at(-1)![0].env
        expect(spawnEnv.ORCA_AGENT_HOOK_PORT).toBe('5678')
        expect(spawnEnv).not.toBe(argsEnv)
      })
      it('rejects a caller-supplied sessionId that escapes userData via ..', async () => {
        // Reject traversal before session identity reaches filesystem side effects.
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
        // Failed spawns must clear filesystem state for newly minted IDs.
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
        // Caller-supplied IDs may own live PTYs; failed retries must not sweep them.
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
    })
  })

  describe('daemon host env: where the lanes differ today', () => {
    const { setupDaemonAdapter } = createDaemonActiveProviderFixtures({ handlers, mainWindow })

    function startLanes() {
      const daemonSpawn = setupDaemonAdapter()
      let controller: { spawn: (args: Record<string, unknown>) => Promise<unknown> } | undefined
      const runtime = {
        setPtyController: vi.fn((next) => {
          controller = next
        }),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPreAllocatedHandleForPty: vi.fn(),
        registerPty: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      return {
        daemonSpawn,
        spawn: (lane: 'window' | 'host', request: Record<string, unknown>) =>
          lane === 'window'
            ? handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, ...request })
            : controller!.spawn({ cols: 80, rows: 24, ...request })
      }
    }

    // Only the id this request minted is swept; an operation id or caller id may name a live PTY.
    it.each([
      { lane: 'window', name: 'a minted id', request: {}, swept: true },
      { lane: 'window', name: 'a caller id', request: { sessionId: 'caller-1' }, swept: false },
      { lane: 'host', name: 'a minted id', request: {}, swept: true },
      {
        lane: 'host',
        name: 'an operation id',
        request: { worktreeId: 'wt-alpha', agentSessionCreateOperationId: 'a'.repeat(43) },
        swept: false
      },
      {
        lane: 'host',
        name: 'a new caller id',
        request: { sessionId: 'caller-1', isNewSession: true },
        swept: false
      }
    ] as const)('$lane lane, $name: a failed env build sweeps per-PTY state: $swept', async (c) => {
      const lanes = startLanes()
      piBuildPtyEnvMock.mockImplementationOnce(() => {
        throw new Error('env boom')
      })

      await expect(lanes.spawn(c.lane, { env: {}, ...c.request })).rejects.toThrow('env boom')
      expect(lanes.daemonSpawn).not.toHaveBeenCalled()
      expect(piClearPtyMock).toHaveBeenCalledTimes(c.swept ? 1 : 0)
    })

    // Current host/window difference: the host accepts an empty ID without host env; the window rejects it.
    it('an empty session id: the window refuses it; the host spawns without host env', async () => {
      const lanes = startLanes()
      await expect(lanes.spawn('window', { env: {}, sessionId: '' })).rejects.toThrow(
        /Invalid PTY session id/
      )
      await lanes.spawn('host', { env: {}, sessionId: '' })
      expect(lanes.daemonSpawn.mock.calls.at(-1)![0].env.ORCA_AGENT_HOOK_PORT).toBeUndefined()
      expect(piBuildPtyEnvMock).not.toHaveBeenCalled()
    })

    it('both daemon lanes run the WSL Pi/OMP guest readiness wait once', async () => {
      const lanes = startLanes()
      vi.mocked(awaitExplicitAgentPluginGuestReadiness).mockClear()
      await lanes.spawn('window', { env: {}, command: 'pi' })
      expect(vi.mocked(awaitExplicitAgentPluginGuestReadiness)).toHaveBeenCalledOnce()
      await lanes.spawn('host', { env: {}, command: 'pi' })
      expect(vi.mocked(awaitExplicitAgentPluginGuestReadiness)).toHaveBeenCalledTimes(2)
    })

    it('both daemon lanes stamp the pane identity and jcode dir from the spawn ids', async () => {
      const lanes = startLanes()
      const leafId = '11111111-2222-4333-8444-555555555555'
      const paneKey = `tab-1:${leafId}`
      const jcodeDir = shouldInjectJcodeRuntimeDir(process.platform)
        ? buildJcodeRuntimeDir(paneKey)
        : undefined
      for (const lane of ['window', 'host'] as const) {
        await lanes.spawn(lane, {
          env: { ORCA_PANE_KEY: 'stale-tab:stale-leaf' },
          tabId: 'tab-1',
          leafId,
          launchAgent: 'jcode'
        })
        const env = lanes.daemonSpawn.mock.calls.at(-1)![0].env
        expect(env.ORCA_PANE_KEY).toBe(paneKey)
        expect(env.ORCA_TAB_ID).toBe('tab-1')
        expect(env[JCODE_RUNTIME_DIR_ENV_KEY]).toBe(jcodeDir)
      }
    })
  })
})
