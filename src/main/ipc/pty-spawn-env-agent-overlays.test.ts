import { describe, expect, it, vi } from 'vitest'
import {
  readFileSyncMock,
  spawnMock,
  openCodeBuildPtyEnvMock,
  mimoCodeBuildPtyEnvMock,
  piBuildPtyEnvMock
} from './pty-ipc-mock-registry'
import { posixOnlyIt } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import type { TuiAgent } from '../../shared/tui-agent'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'

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
  const { spawnAndGetEnv } = setupPtyIpcSuite()

  describe('spawn environment', () => {
    it('prepares Codex launch state for the workspace before spawning an interactive tab', async () => {
      const workspacePath = '/repo/worktrees/new-feature'
      const resolveHome = vi.fn(
        (
          _target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null },
          _launchEnv?: NodeJS.ProcessEnv,
          _launchContext?: { workspacePath?: string; launchAgent?: TuiAgent }
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
      expect(resolveHome.mock.calls[0]?.[2]).toEqual({ workspacePath, launchAgent: 'codex' })
      expect(resolveHome.mock.invocationCallOrder[0]).toBeLessThan(
        spawnMock.mock.invocationCallOrder[0]!
      )
    })
    it('injects the OpenCode hook env into Orca terminal PTYs', async () => {
      // Why: clear any ambient OPENCODE_CONFIG_DIR so the mock's value is used
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
        ORCA_OPENCODE_SOURCE_CONFIG_DIR: '/tmp/user-opencode-config'
      })
      expect(openCodeBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/user-opencode-config'
      )
      expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
      expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
      expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe('/tmp/user-opencode-config')
    })
    it('does not treat inherited Orca OpenCode config as user config without a source dir', async () => {
      const env = await spawnAndGetEnv({
        OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay',
        ORCA_OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay'
      })

      expect(openCodeBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined)
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
    it.each(['/usr/local/bin/mimo --prompt hi', '"C:\\Program Files\\MiMo\\mimo.cmd" --prompt hi'])(
      'injects MiMo overlay env for path-qualified launch command %s',
      async (launchCommand) => {
        const env = await spawnAndGetEnv(undefined, undefined, undefined, undefined, launchCommand)

        expect(mimoCodeBuildPtyEnvMock).toHaveBeenCalledTimes(1)
        expect(env.MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
        expect(env.ORCA_MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
      }
    )
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
        // Why: the reporter's app didn't inherit OPENCODE_CONFIG_DIR; their interactive zsh later exported a company config repo.
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

        const env = await spawnAndGetEnv(undefined, {
          HOME: '/home/pim',
          SHELL: '/bin/zsh',
          OPENCODE_CONFIG_DIR: undefined,
          ORCA_OPENCODE_SOURCE_CONFIG_DIR: undefined
        })

        expect(openCodeBuildPtyEnvMock).toHaveBeenCalledWith(
          expect.any(String),
          '/home/pim/company/opencode-config'
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
    it('threads command: "omp" through to piBuildPtyEnv and emits OMP status metadata', async () => {
      // Why: OMP launches emit ORCA_OMP_* shadow vars, not Pi-named ones; only PI_CODING_AGENT_DIR stays (OMP's own binary reads it).
      const env = await spawnAndGetEnv(
        undefined,
        { PI_CODING_AGENT_DIR: '/tmp/user-omp-agent' },
        undefined,
        undefined,
        'omp'
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
      // CRITICAL: a Pi-named shadow MUST NOT leak into an OMP PTY env.
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
