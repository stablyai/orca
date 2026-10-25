import { getDefaultSettings } from '../../../shared/constants'
import { buildPtyHostEnv } from './host-env/assembly'
import { registerPtyHandlers } from './register-handlers'
import { createDaemonActiveProviderFixtures } from '../pty-ipc-daemon-provider-fixtures'
import { join } from 'node:path'
import { withFreshOmpLaunch } from '../../../shared/omp-fresh-launch'
import { describe, expect, it, vi } from 'vitest'
import {
  readFileSyncMock,
  spawnMock,
  openCodeBuildPtyEnvMock,
  mimoCodeBuildPtyEnvMock,
  piBuildPtyEnvMock
} from '../pty-ipc-mock-registry'
import { posixOnlyIt, TEST_MANAGED_ROOT } from '../pty-ipc-test-constants'
import { setupPtyIpcSuite } from '../pty-ipc-test-harness'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../shared/setup-agent-sequencing'

const consumerConfigHome = join(TEST_MANAGED_ROOT, 'opencode-consumer-config')

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

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, spawnAndGetEnv } = setupPtyIpcSuite()

  describe('spawn environment', () => {
    describe('Claude terminal image detection', () => {
      it.each([undefined, true, false])(
        'enables managed Claude images according to the setting %s',
        async (terminalInlineImages) => {
          const env = await spawnAndGetEnv(
            undefined,
            { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: undefined },
            undefined,
            () => ({ agentStatusHooksEnabled: false, terminalInlineImages }),
            'wrapped-claude-launch',
            'claude'
          )
          expect(env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES).toBe(
            terminalInlineImages === false ? undefined : '1'
          )
          expect(env.TERM_PROGRAM).toBe('Orca')
        }
      )

      it.each(['0', '1', ''])('preserves the explicit override %j', async (value) => {
        const env = await spawnAndGetEnv(
          { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: value },
          { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: undefined },
          undefined,
          undefined,
          'claude',
          'claude'
        )
        expect(env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES).toBe(value)
      })

      it.each([undefined, 'codex', 'pi'] as const)(
        'does not force images for agent identity %s',
        async (launchAgent) => {
          const env = await spawnAndGetEnv(
            undefined,
            { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: undefined },
            undefined,
            undefined,
            launchAgent === undefined ? undefined : 'claude is mentioned in this command',
            launchAgent
          )
          expect(env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES).toBeUndefined()
        }
      )

      it('respects an inherited opt-out before sparse daemon env is merged', () => {
        vi.stubEnv('CLAUDE_CODE_FORCE_TERMINAL_IMAGES', '0')
        try {
          const env = buildPtyHostEnv(
            'claude-opt-out',
            {},
            {
              isPackaged: false,
              userDataPath: '/tmp/orca-user-data',
              selectedCodexHomePath: null,
              agentStatusHooksEnabled: false,
              launchAgent: 'claude'
            }
          )
          expect(env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES).toBeUndefined()
          expect(process.env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES).toBe('0')
        } finally {
          vi.unstubAllEnvs()
        }
      })

      it.each([true, false])('uses the image setting %s in daemon IPC spawns', async (enabled) => {
        vi.stubEnv('CLAUDE_CODE_FORCE_TERMINAL_IMAGES', undefined)
        try {
          const { setupDaemonAdapter } = createDaemonActiveProviderFixtures({
            handlers,
            mainWindow
          })
          const daemonSpawn = setupDaemonAdapter()
          registerPtyHandlers(mainWindow, undefined, undefined, () => ({
            ...getDefaultSettings('/tmp'),
            agentStatusHooksEnabled: false,
            terminalInlineImages: enabled
          }))
          await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            launchAgent: 'claude',
            command: 'wrapped-claude-launch'
          })
          expect(daemonSpawn.mock.calls.at(-1)?.[0].env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES).toBe(
            enabled ? '1' : undefined
          )
        } finally {
          vi.unstubAllEnvs()
        }
      })
    })
    it('prepares Codex launch state before spawning an interactive tab', async () => {
      const workspacePath = '/repo/worktrees/new-feature'
      const resolveHome = vi.fn(
        (
          _target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null },
          _launchEnv?: NodeJS.ProcessEnv,
          _launchContext?: { unavailableManagedHomePath?: string }
        ) => null
      )

      await spawnAndGetEnv(
        undefined,
        undefined,
        resolveHome,
        undefined,
        'codex',
        'codex',
        workspacePath,
        `repo-id::${workspacePath}`
      )

      expect(resolveHome.mock.calls[0]?.[0]).toEqual({ runtime: 'host' })
      expect(resolveHome.mock.invocationCallOrder[0]).toBeLessThan(
        spawnMock.mock.invocationCallOrder[0]!
      )
    })
    it('injects the OpenCode hook env into Orca terminal PTYs', async () => {
      const env = await spawnAndGetEnv(undefined, { OPENCODE_CONFIG_DIR: undefined })
      expect(openCodeBuildPtyEnvMock).toHaveBeenCalledTimes(1)
      expect(openCodeBuildPtyEnvMock.mock.calls[0]?.[0]).toEqual(expect.any(String))
      expect(env.ORCA_OPENCODE_HOOK_PORT).toBe('4567')
      expect(env.ORCA_OPENCODE_HOOK_TOKEN).toBe('opencode-token')
      expect(env.ORCA_OPENCODE_PTY_ID).toBe('test-pty')
      expect(env.OPENCODE_CONFIG_DIR).toEqual(expect.any(String))
      expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe(env.OPENCODE_CONFIG_DIR)
    })
    it('mirrors the original OpenCode source dir when launched from an Orca overlay shell', async () => {
      const env = await spawnAndGetEnv({
        OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay',
        ORCA_OPENCODE_SOURCE_CONFIG_DIR: '/tmp/user-opencode-config',
        XDG_CONFIG_HOME: consumerConfigHome
      })
      expect(openCodeBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/user-opencode-config',
        join(consumerConfigHome, 'opencode')
      )
      expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
      expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
      expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe('/tmp/user-opencode-config')
    })
    it('does not treat inherited Orca OpenCode config as user config without a source dir', async () => {
      const env = await spawnAndGetEnv({
        OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay',
        ORCA_OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay',
        XDG_CONFIG_HOME: consumerConfigHome
      })

      expect(openCodeBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        join(consumerConfigHome, 'opencode')
      )
      expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-config')
      expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-config')
      expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
    })
    it('restores user OpenCode config when agent status hooks are disabled in a nested Orca shell', async () => {
      const env = await spawnAndGetEnv(
        {
          OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay',
          ORCA_OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay',
          ORCA_OPENCODE_SOURCE_CONFIG_DIR: '/tmp/user-opencode-config'
        },
        undefined,
        undefined,
        () => ({ agentStatusHooksEnabled: false })
      )

      expect(openCodeBuildPtyEnvMock).not.toHaveBeenCalled()
      expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/user-opencode-config')
      expect(env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
    })
    it('strips inherited OpenCode overlay env when agent status hooks are disabled without a source dir', async () => {
      const env = await spawnAndGetEnv(
        {
          OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay',
          ORCA_OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay'
        },
        undefined,
        undefined,
        () => ({ agentStatusHooksEnabled: false })
      )

      expect(openCodeBuildPtyEnvMock).not.toHaveBeenCalled()
      expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
    })
    it('injects MiMo overlay env only when launch command is mimo', async () => {
      const env = await spawnAndGetEnv(undefined, undefined, undefined, undefined, 'mimo')

      expect(mimoCodeBuildPtyEnvMock).toHaveBeenCalledTimes(1)
      expect(env.MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
      expect(env.ORCA_MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
      expect(env.ORCA_MIMOCODE_SOURCE_HOME).toBeUndefined()
    })
    it.each([
      '/usr/local/bin/mimo --prompt hi',
      '"C:\\Program Files\\MiMo\\mimo.cmd" --prompt hi',
      'sleep 30 && mimo --prompt hi'
    ])('injects MiMo overlay env for path-qualified launch command %s', async (launchCommand) => {
      const env = await spawnAndGetEnv(undefined, undefined, undefined, undefined, launchCommand)

      expect(mimoCodeBuildPtyEnvMock).toHaveBeenCalledTimes(1)
      expect(env.MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
      expect(env.ORCA_MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
    })
    it('uses sequenced startup env as the MiMo launch hint when command is a wrapper', async () => {
      const env = await spawnAndGetEnv(
        { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'mimo --prompt hi' },
        undefined,
        undefined,
        undefined,
        'bash -lc wait-wrapper'
      )

      expect(mimoCodeBuildPtyEnvMock).toHaveBeenCalledTimes(1)
      expect(env.MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
      expect(env.ORCA_MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
    })
    it('does not inject MiMo overlay for non-mimo launches', async () => {
      await spawnAndGetEnv()

      expect(mimoCodeBuildPtyEnvMock).not.toHaveBeenCalled()
    })
    it('restores user MiMo home when agent status hooks are disabled in a nested Orca shell', async () => {
      const env = await spawnAndGetEnv(
        {
          MIMOCODE_HOME: '/tmp/parent-orca-mimocode-overlay',
          ORCA_MIMOCODE_HOME: '/tmp/parent-orca-mimocode-overlay',
          ORCA_MIMOCODE_SOURCE_HOME: '/tmp/user-mimocode-home'
        },
        undefined,
        undefined,
        () => ({ agentStatusHooksEnabled: false }),
        'mimo'
      )

      expect(mimoCodeBuildPtyEnvMock).not.toHaveBeenCalled()
      expect(env.MIMOCODE_HOME).toBe('/tmp/user-mimocode-home')
      expect(env.ORCA_MIMOCODE_HOME).toBeUndefined()
      expect(env.ORCA_MIMOCODE_SOURCE_HOME).toBeUndefined()
    })
    posixOnlyIt(
      'reproduces issue #1534: GUI-launched Orca mirrors zshrc-only OpenCode config',
      async () => {
        // Model config exported by interactive zsh but absent from the GUI environment.
        readFileSyncMock.mockImplementation((path: string) => {
          if (path.endsWith('.zshrc')) {
            return [
              '# Company-wide OpenCode config loaded by interactive shells',
              'export OPENCODE_CONFIG_DIR="$HOME/company/opencode-config"',
              ''
            ].join('\n')
          }
          return ''
        })

        const env = await spawnAndGetEnv(
          { XDG_CONFIG_HOME: consumerConfigHome },
          {
            HOME: '/home/pim',
            SHELL: '/bin/zsh',
            OPENCODE_CONFIG_DIR: undefined,
            ORCA_OPENCODE_SOURCE_CONFIG_DIR: undefined
          }
        )

        expect(openCodeBuildPtyEnvMock).toHaveBeenCalledWith(
          expect.any(String),
          '/home/pim/company/opencode-config',
          join(consumerConfigHome, 'opencode')
        )
        expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
        expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
        expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe('/home/pim/company/opencode-config')
        expect(env.OPENCODE_CONFIG_DIR).not.toBe(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR)
      }
    )
    it('installs Pi managed extensions without redirecting Orca terminal PTY homes', async () => {
      const env = await spawnAndGetEnv(undefined, { PI_CODING_AGENT_DIR: '/tmp/user-pi-agent' })
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/user-pi-agent',
        'pi',
        {
          materializeDefaultHome: false
        }
      )
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'omp', {
        materializeDefaultHome: false
      })
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/user-pi-agent')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/tmp/user-pi-agent')
      expect(env.ORCA_OMP_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(
        '/tmp/orca-user-data/omp-managed-status-extension/orca-agent-status.ts'
      )
      expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBeUndefined()
    })
    it('does not materialize a missing Pi home when another agent mentions Pi', async () => {
      const env = await spawnAndGetEnv(
        undefined,
        undefined,
        undefined,
        undefined,
        'codex "ask about pi"',
        'codex'
      )

      expect(piBuildPtyEnvMock).toHaveBeenCalledTimes(1)
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'pi', {
        materializeDefaultHome: false
      })
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
    })
    it('materializes Pi home for an explicit Pi launch through a custom command', async () => {
      const env = await spawnAndGetEnv(
        undefined,
        undefined,
        undefined,
        undefined,
        'custom-pi-wrapper',
        'pi'
      )

      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'pi', {
        materializeDefaultHome: true
      })
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/tmp/default-pi-agent')
    })
    it.each([
      'omp',
      withFreshOmpLaunch('omp', 'posix'),
      withFreshOmpLaunch('omp', 'powershell'),
      withFreshOmpLaunch('omp', 'cmd')
    ])('threads OMP command %s through to the host integration', async (command) => {
      // OMP needs ORCA_OMP shadows; retain only the public Pi-named variable its binary reads.
      const env = await spawnAndGetEnv(
        undefined,
        { PI_CODING_AGENT_DIR: '/tmp/user-omp-agent' },
        undefined,
        undefined,
        command
      )
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/user-omp-agent',
        'omp',
        { materializeDefaultHome: true }
      )
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/user-omp-agent')
      expect(env.ORCA_OMP_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(
        '/tmp/user-omp-agent/extensions/orca-agent-status.ts'
      )
      expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBe('/tmp/user-omp-agent')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
    })
    it('installs Prime status into its independent agent dir on explicit launch', async () => {
      const env = await spawnAndGetEnv(
        undefined,
        {
          PI_CODING_AGENT_DIR: '/tmp/user-pi-agent',
          PRIME_AGENT_CODING_AGENT_DIR: '/tmp/user-prime-agent'
        },
        undefined,
        undefined,
        'prime-agent'
      )

      expect(piBuildPtyEnvMock).toHaveBeenCalledTimes(1)
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/user-prime-agent',
        'prime-agent',
        { materializeDefaultHome: true }
      )
      expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBe('/tmp/user-prime-agent')
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/user-pi-agent')
      expect(env.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR).toBe('/tmp/user-prime-agent')
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBeUndefined()
    })
    it('uses sequenced startup env as the OMP launch hint when command is a wrapper', async () => {
      const env = await spawnAndGetEnv(
        {
          PI_CODING_AGENT_DIR: '/tmp/user-omp-agent',
          [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'omp --resume'
        },
        undefined,
        undefined,
        undefined,
        'powershell wait-wrapper'
      )

      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/user-omp-agent',
        'omp',
        { materializeDefaultHome: true }
      )
      expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(
        '/tmp/user-omp-agent/extensions/orca-agent-status.ts'
      )
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
    })
    it('mirrors the original Pi source dir when launched from an Orca overlay shell', async () => {
      const env = await spawnAndGetEnv({
        PI_CODING_AGENT_DIR: '/tmp/parent-orca-pi-overlay',
        ORCA_PI_SOURCE_AGENT_DIR: '/tmp/user-pi-agent'
      })
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/user-pi-agent',
        'pi',
        {
          materializeDefaultHome: false
        }
      )
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/parent-orca-pi-overlay')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/tmp/user-pi-agent')
    })
  })
})
