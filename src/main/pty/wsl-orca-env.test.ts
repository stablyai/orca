import { describe, expect, it } from 'vitest'
import { isAbsolute } from 'node:path'
import { getShellReadyWrapperRoot } from '../providers/local-pty-shell-ready-wrapper-root'
import {
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from '../../shared/setup-agent-sequencing'
import { addOrcaWslInteropEnv, stampWslOrchestrationCompatibilityHost } from './wsl-orca-env'
import { CODEX_REMOTE_VIEWER_SSH_CONNECTION } from '../ipc/pty/host-env/remote-viewer-clipboard-env'

describe('addOrcaWslInteropEnv', () => {
  it.each(['1', '0'])(
    'forwards Claude image override %s to WSL without path translation',
    (value) => {
      const env: Record<string, string> = { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: value }

      addOrcaWslInteropEnv(env)
      addOrcaWslInteropEnv(env)

      expect(env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES).toBe(value)
      expect(
        env.WSLENV.split(':').filter((entry) =>
          entry.startsWith('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')
        )
      ).toEqual(['CLAUDE_CODE_FORCE_TERMINAL_IMAGES/u'])
    }
  )

  it('marks the Orca terminal handle for Windows to WSL env import', () => {
    const env: Record<string, string> = { ORCA_TERMINAL_HANDLE: 'term_wsl' }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toBe('ORCA_TERMINAL_HANDLE/u:ORCA_SHELL_READY_ROOT/p')
  })

  // Guests cannot derive the wrapper content hash from userData; publish the resolved root to avoid unwrapped launches.
  it('publishes the resolved wrapper root path-translated for the guest', () => {
    const env: Record<string, string> = {}

    addOrcaWslInteropEnv(env)

    expect(env.ORCA_SHELL_READY_ROOT).toBe(getShellReadyWrapperRoot())
    expect(isAbsolute(env.ORCA_SHELL_READY_ROOT as string)).toBe(true)
    // Translate the host wrapper path for guest access.
    expect(env.WSLENV?.split(':')).toContain('ORCA_SHELL_READY_ROOT/p')
  })

  it('imports setup-gated startup env into WSL without path translation', () => {
    const env: Record<string, string> = {
      [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'codex',
      [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: 'while :; do sleep 1; done'
    }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV?.split(':')).toEqual([
      'ORCA_SHELL_READY_ROOT/p',
      `${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}/u`,
      `${SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV}/u`
    ])
  })

  it('preserves existing WSLENV entries and does not duplicate the handle entry', () => {
    const env: Record<string, string> = {
      WSLENV: 'FOO/u:ORCA_TERMINAL_HANDLE/u:BAR/p'
    }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toBe('FOO/u:ORCA_TERMINAL_HANDLE/u:BAR/p:ORCA_SHELL_READY_ROOT/p')
  })

  it('marks OMP status and hook env for Windows to WSL import', () => {
    const env: Record<string, string> = {
      ORCA_TERMINAL_HANDLE: 'term_wsl',
      ORCA_USER_DATA_PATH: 'C:\\Users\\jin\\AppData\\Roaming\\Orca',
      ORCA_CLI_COMMAND: 'orca-ide',
      ORCA_WSL_CLI_DIR: 'C:\\Users\\jin\\AppData\\Roaming\\Orca\\wsl-managed-cli\\hash',
      ORCA_CODEX_LAUNCH_PREFLIGHT: 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe',
      ORCA_CODEX_ISOLATE: '0',
      ORCA_OMP_FRESH_CONFIG: 'C:\\Orca\\fresh-session.yml',
      ORCA_OMP_STATUS_EXTENSION: 'C:\\Users\\jin\\.omp\\agent\\extensions\\orca-agent-status.ts',
      ORCA_PRIME_AGENT_STATUS_EXTENSION: 'C:\\stale\\orca-agent-status.ts',
      ORCA_PANE_KEY: 'tab-1:leaf-1',
      ORCA_AGENT_PANE: 'tab-1:leaf-1',
      ORCA_TAB_ID: 'tab-1',
      ORCA_WORKTREE_ID: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch-secret',
      ORCA_AGENT_LAUNCH: 'launch-secret',
      ORCA_OPENCODE_AGENT: 'opencode2',
      ORCA_AGENT_HOOK_PORT: '4567',
      ORCA_AGENT_HOOK_TOKEN: 'token',
      ORCA_AGENT_HOOK_ENV: 'dev',
      ORCA_AGENT_HOOK_VERSION: '1',
      ORCA_AGENT_HOOK_TRANSPORT: 'raw-json-v1',
      ORCA_WSL_HOOK_INSTANCE: 'testinstance',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'wsl',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'local',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'Ubuntu',
      ORCA_RUNTIME_SOURCE_ID: '11111111-1111-4111-8111-111111111111',
      ORCA_RUNTIME_SOURCE_INCARNATION: 'runtime-a',
      ORCA_RUNTIME_SOURCE_PROFILE_PATH: 'C:\\Users\\a\\AppData\\Roaming\\orca'
    }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toContain('ORCA_TERMINAL_HANDLE/u')
    expect(env.WSLENV).toContain('ORCA_USER_DATA_PATH/p')
    expect(env.WSLENV).toContain('ORCA_CLI_COMMAND/u')
    expect(env.WSLENV).toContain('ORCA_WSL_CLI_DIR/p')
    expect(env.WSLENV).toContain('ORCA_CODEX_LAUNCH_PREFLIGHT/p')
    expect(env.WSLENV).toContain('ORCA_CODEX_ISOLATE/u')
    expect(env.WSLENV).toContain('ORCA_OMP_STATUS_EXTENSION/p')
    expect(env.WSLENV).toContain('ORCA_OMP_FRESH_CONFIG/p')
    expect(env.WSLENV).not.toContain('ORCA_PRIME_AGENT_STATUS_EXTENSION')
    expect(env.WSLENV).toContain('ORCA_PANE_KEY/u')
    expect(env.WSLENV).toContain('ORCA_AGENT_PANE/u')
    expect(env.WSLENV).toContain('ORCA_TAB_ID/u')
    expect(env.WSLENV).toContain('ORCA_WORKTREE_ID/u')
    expect(env.WSLENV).toContain('ORCA_AGENT_LAUNCH_TOKEN/u')
    expect(env.WSLENV).toContain('ORCA_AGENT_LAUNCH/u')
    expect(env.WSLENV).toContain('ORCA_OPENCODE_AGENT/u')
    expect(env.WSLENV).toContain('ORCA_AGENT_HOOK_PORT/u')
    expect(env.WSLENV).toContain('ORCA_AGENT_HOOK_TOKEN/u')
    expect(env.WSLENV).toContain('ORCA_AGENT_HOOK_ENV/u')
    expect(env.WSLENV).toContain('ORCA_AGENT_HOOK_VERSION/u')
    expect(env.WSLENV).toContain('ORCA_AGENT_HOOK_TRANSPORT/u')
    expect(env.WSLENV).toContain('ORCA_WSL_HOOK_INSTANCE/u')
    expect(env.WSLENV).toContain('ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND/u')
    expect(env.WSLENV).toContain('ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID/u')
    expect(env.WSLENV).toContain('ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION/u')
    expect(env.WSLENV).toContain('ORCA_RUNTIME_SOURCE_ID/u')
    expect(env.WSLENV).toContain('ORCA_RUNTIME_SOURCE_INCARNATION/u')
    expect(env.WSLENV).toContain('ORCA_RUNTIME_SOURCE_PROFILE_PATH/u')
  })

  it('overwrites caller host evidence with native runtime WSL authority', () => {
    const env = {
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'ssh',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'caller-host',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'caller-incarnation',
      ORCA_ORCHESTRATION_COMPATIBILITY_ATTACHMENT: 'caller-attachment'
    }

    stampWslOrchestrationCompatibilityHost(env, 'local', 'Ubuntu')

    expect(env).toEqual({
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'wsl',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'local',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'Ubuntu'
    })
  })

  it('clears inherited host evidence outside a runtime-owned WSL scope', () => {
    const env = {
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'ssh',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'caller-host',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'caller-incarnation',
      ORCA_ORCHESTRATION_COMPATIBILITY_ATTACHMENT: 'caller-attachment'
    }

    stampWslOrchestrationCompatibilityHost(env, 'local', null)

    expect(env).toEqual({})
  })

  it('path-translates a Windows hook endpoint but passes a guest-side one untouched', () => {
    const windowsEnv: Record<string, string> = {
      ORCA_AGENT_HOOK_ENDPOINT: 'C:\\Users\\jin\\AppData\\Roaming\\Orca\\agent-hooks\\endpoint.cmd'
    }
    addOrcaWslInteropEnv(windowsEnv)
    expect(windowsEnv.WSLENV).toContain('ORCA_AGENT_HOOK_ENDPOINT/p')

    const guestEnv: Record<string, string> = {
      ORCA_AGENT_HOOK_ENDPOINT: '/home/jin/.orca-wsl/agent-hooks/port-4567/endpoint.env'
    }
    addOrcaWslInteropEnv(guestEnv)
    expect(guestEnv.WSLENV).toContain('ORCA_AGENT_HOOK_ENDPOINT/u')
    expect(guestEnv.WSLENV).not.toContain('ORCA_AGENT_HOOK_ENDPOINT/p')
  })

  it('tags pre-translated Linux setup paths /u so WSLENV does not translate them again (#9206)', () => {
    const env: Record<string, string> = {
      ORCA_ROOT_PATH: '/home/jin/repo',
      ORCA_WORKTREE_PATH: '/home/jin/repo-worktrees/fix-1',
      ORCA_WORKSPACE_NAME: 'fix-1',
      CONDUCTOR_ROOT_PATH: '/home/jin/repo',
      GHOSTX_ROOT_PATH: '/home/jin/repo'
    }

    addOrcaWslInteropEnv(env)

    // Already-Linux hook paths must cross untranslated to avoid a second conversion.
    expect(env.WSLENV).toContain('ORCA_ROOT_PATH/u')
    expect(env.WSLENV).toContain('ORCA_WORKTREE_PATH/u')
    expect(env.WSLENV).toContain('CONDUCTOR_ROOT_PATH/u')
    expect(env.WSLENV).toContain('GHOSTX_ROOT_PATH/u')
    expect(env.WSLENV).not.toContain('ORCA_ROOT_PATH/p')
    expect(env.WSLENV).not.toContain('ORCA_WORKTREE_PATH/p')
    expect(env.ORCA_ROOT_PATH).toBe('/home/jin/repo')
    expect(env.ORCA_WORKTREE_PATH).toBe('/home/jin/repo-worktrees/fix-1')
  })

  it('tags untranslated Windows setup paths /p so WSLENV translates them (wsl.exe shell over a Windows worktree)', () => {
    const env: Record<string, string> = {
      ORCA_ROOT_PATH: 'C:\\Users\\jin\\repo',
      ORCA_WORKTREE_PATH: 'C:\\Users\\jin\\repo-worktrees\\fix-1',
      CONDUCTOR_ROOT_PATH: 'C:\\Users\\jin\\repo',
      GHOSTX_ROOT_PATH: 'C:\\Users\\jin\\repo'
    }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toContain('ORCA_ROOT_PATH/p')
    expect(env.WSLENV).toContain('ORCA_WORKTREE_PATH/p')
    expect(env.WSLENV).toContain('CONDUCTOR_ROOT_PATH/p')
    expect(env.WSLENV).toContain('GHOSTX_ROOT_PATH/p')
    expect(env.WSLENV).not.toContain('ORCA_ROOT_PATH/u')
    expect(env.WSLENV).not.toContain('ORCA_WORKTREE_PATH/u')
  })

  it('always tags ORCA_WORKSPACE_NAME /u because it is a name, not a path', () => {
    const env: Record<string, string> = { ORCA_WORKSPACE_NAME: 'fix-1' }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toBe('ORCA_SHELL_READY_ROOT/p:ORCA_WORKSPACE_NAME/u')
  })

  it.each(['repo::\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo', 'folder:f1'])(
    'crosses the workspace id %s into the guest untranslated (/u), as the window and main stamp it',
    (workspaceId) => {
      const env: Record<string, string> = { ORCA_WORKSPACE_ID: workspaceId }

      addOrcaWslInteropEnv(env)

      expect(env.ORCA_WORKSPACE_ID).toBe(workspaceId)
      expect(env.WSLENV?.split(':')).toContain('ORCA_WORKSPACE_ID/u')
    }
  )

  // #10861: wsl.exe drops SSH_CONNECTION, so WSL Codex copied only to the Windows clipboard.
  it('crosses the Codex remote-viewer clipboard marker into the guest untranslated (/u)', () => {
    const env: Record<string, string> = { SSH_CONNECTION: CODEX_REMOTE_VIEWER_SSH_CONNECTION }
    addOrcaWslInteropEnv(env)
    expect(env.WSLENV?.split(':')).toContain('SSH_CONNECTION/u')
  })

  it("leaves the Windows host's own SSH session out of the guest", () => {
    const env: Record<string, string> = { SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' }
    addOrcaWslInteropEnv(env)
    expect(env.WSLENV?.split(':')).not.toContain('SSH_CONNECTION/u')
  })

  it('crosses the inline-image protocol hint into the guest untranslated (/u)', () => {
    const env: Record<string, string> = { ORCA_IMAGE_PROTOCOL: 'kitty' }
    addOrcaWslInteropEnv(env)
    expect(env.WSLENV).toContain('ORCA_IMAGE_PROTOCOL/u')
  })

  it('marks the WSL hook relay version for import on relay spawn envs', () => {
    const env: Record<string, string> = {
      ORCA_WSL_HOOK_RELAY_VERSION: '0.1.0+abc'
    }
    addOrcaWslInteropEnv(env)
    expect(env.WSLENV).toBe('ORCA_SHELL_READY_ROOT/p:ORCA_WSL_HOOK_RELAY_VERSION/u')
  })

  it('crosses a guest-side OpenCode config overlay untranslated (/u)', () => {
    const env: Record<string, string> = {
      OPENCODE_CONFIG_DIR: '/home/jin/.orca-relay/opencode-overlays/abc',
      ORCA_OPENCODE_CONFIG_DIR: '/home/jin/.orca-relay/opencode-overlays/abc'
    }
    addOrcaWslInteropEnv(env)
    expect(env.WSLENV).toContain('OPENCODE_CONFIG_DIR/u')
    expect(env.WSLENV).toContain('ORCA_OPENCODE_CONFIG_DIR/u')
    expect(env.WSLENV).not.toContain('OPENCODE_CONFIG_DIR/p')
  })

  it('never crosses a Windows OpenCode config dir into the guest', () => {
    // Windows overlays can leak through inherited relay/daemon env; never translate them into guest OpenCode config roots.
    const env: Record<string, string> = {
      OPENCODE_CONFIG_DIR: 'C:\\Users\\jin\\AppData\\Roaming\\Orca\\opencode-overlays\\abc',
      ORCA_OPENCODE_CONFIG_DIR: 'C:\\Users\\jin\\AppData\\Roaming\\Orca\\opencode-overlays\\abc'
    }
    addOrcaWslInteropEnv(env)
    expect(env.WSLENV).not.toContain('OPENCODE_CONFIG_DIR')
    expect(env.WSLENV).not.toContain('ORCA_OPENCODE_CONFIG_DIR')
  })

  it('does not register the OpenCode config vars when they are absent', () => {
    const env: Record<string, string> = { ORCA_TERMINAL_HANDLE: 'term_wsl' }
    addOrcaWslInteropEnv(env)
    expect(env.WSLENV).not.toContain('OPENCODE_CONFIG_DIR')
    expect(env.WSLENV).not.toContain('ORCA_OPENCODE_CONFIG_DIR')
  })
})
