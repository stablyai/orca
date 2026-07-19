import { describe, expect, it } from 'vitest'
import { addOrcaWslInteropEnv } from './wsl-orca-env'
import { ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV } from '../../shared/wsl-opencode-materializer-contract'

describe('addOrcaWslInteropEnv', () => {
  it('marks the Orca terminal handle for Windows to WSL env import', () => {
    const env: Record<string, string> = { ORCA_TERMINAL_HANDLE: 'term_wsl' }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toBe('ORCA_TERMINAL_HANDLE/u')
  })

  it('preserves existing WSLENV entries and does not duplicate the handle entry', () => {
    const env: Record<string, string> = {
      WSLENV: 'FOO/u:ORCA_TERMINAL_HANDLE/u:BAR/p'
    }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toBe('FOO/u:ORCA_TERMINAL_HANDLE/u:BAR/p')
  })

  it('marks OMP status and hook env for Windows to WSL import', () => {
    const env: Record<string, string> = {
      ORCA_TERMINAL_HANDLE: 'term_wsl',
      ORCA_USER_DATA_PATH: 'C:\\Users\\jin\\AppData\\Roaming\\Orca',
      ORCA_CLI_COMMAND: 'orca-ide',
      ORCA_OMP_STATUS_EXTENSION: 'C:\\Users\\jin\\.omp\\agent\\extensions\\orca-agent-status.ts',
      ORCA_PANE_KEY: 'tab-1:leaf-1',
      ORCA_TAB_ID: 'tab-1',
      ORCA_WORKTREE_ID: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
      ORCA_AGENT_HOOK_PORT: '4567',
      ORCA_AGENT_HOOK_TOKEN: 'token',
      ORCA_AGENT_HOOK_ENV: 'dev',
      ORCA_AGENT_HOOK_VERSION: '1'
    }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toContain('ORCA_TERMINAL_HANDLE/u')
    expect(env.WSLENV).toContain('ORCA_USER_DATA_PATH/p')
    expect(env.WSLENV).toContain('ORCA_CLI_COMMAND/u')
    expect(env.WSLENV).toContain('ORCA_OMP_STATUS_EXTENSION/p')
    expect(env.WSLENV).toContain('ORCA_PANE_KEY/u')
    expect(env.WSLENV).toContain('ORCA_TAB_ID/u')
    expect(env.WSLENV).toContain('ORCA_WORKTREE_ID/u')
    expect(env.WSLENV).toContain('ORCA_AGENT_HOOK_PORT/u')
    expect(env.WSLENV).toContain('ORCA_AGENT_HOOK_TOKEN/u')
    expect(env.WSLENV).toContain('ORCA_AGENT_HOOK_ENV/u')
    expect(env.WSLENV).toContain('ORCA_AGENT_HOOK_VERSION/u')
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

  it('marks the WSL hook relay version for import on relay spawn envs', () => {
    const env: Record<string, string> = { ORCA_WSL_HOOK_RELAY_VERSION: '0.1.0+abc' }
    addOrcaWslInteropEnv(env)
    expect(env.WSLENV).toBe('ORCA_WSL_HOOK_RELAY_VERSION/u')
  })

  it('path-translates only the WSL OpenCode materializer script', () => {
    const env: Record<string, string> = {
      ORCA_WSL_OPENCODE_MATERIALIZER:
        'C:\\Users\\jin\\AppData\\Roaming\\Orca\\wsl-opencode-materializer\\materialize.sh'
    }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toBe('ORCA_WSL_OPENCODE_MATERIALIZER/p')
  })

  it('refuses to import host OpenCode roots even when inherited WSLENV requested them', () => {
    const env: Record<string, string> = {
      WSLENV:
        'KEEP/u:OPENCODE_CONFIG_DIR/p:OPENCODE_CONFIG_DIR/u:ORCA_OPENCODE_CONFIG_DIR/p:ORCA_OPENCODE_SOURCE_CONFIG_DIR/p',
      OPENCODE_CONFIG_DIR: 'C:\\Users\\jin\\opencode-overlay',
      ORCA_OPENCODE_CONFIG_DIR: 'C:\\Users\\jin\\opencode-overlay',
      ORCA_OPENCODE_SOURCE_CONFIG_DIR: 'C:\\Users\\jin\\opencode-source',
      [ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV]: 'C:\\Users\\jin\\stale-guest-source',
      ORCA_WSL_OPENCODE_MATERIALIZER: 'C:\\Users\\jin\\materialize.sh'
    }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toBe('KEEP/u:ORCA_WSL_OPENCODE_MATERIALIZER/p')
  })

  it('crosses only the captured guest source in managed-hook mode', () => {
    const env: Record<string, string> = {
      WSLENV: 'KEEP/u:OPENCODE_CONFIG_DIR/u:ORCA_OPENCODE_SOURCE_CONFIG_DIR/p',
      OPENCODE_CONFIG_DIR: '/home/jin/company-opencode',
      ORCA_OPENCODE_SOURCE_CONFIG_DIR: 'C:\\Users\\jin\\host-source',
      ORCA_WSL_OPENCODE_MATERIALIZER: 'C:\\Users\\jin\\materialize.sh',
      [ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV]: '/home/jin/company-opencode'
    }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV?.split(':')).toEqual([
      'KEEP/u',
      'ORCA_WSL_OPENCODE_MATERIALIZER/p',
      `${ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV}/u`
    ])
  })

  it('preserves an intentional guest OpenCode pass-through when managed hooks are off', () => {
    const env: Record<string, string> = {
      WSLENV: 'KEEP/u:OPENCODE_CONFIG_DIR/u',
      OPENCODE_CONFIG_DIR: '/home/jin/company-opencode'
    }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toBe('KEEP/u:OPENCODE_CONFIG_DIR/u')
    expect(env.OPENCODE_CONFIG_DIR).toBe('/home/jin/company-opencode')
  })

  it('preserves an intentional user OpenCode pass-through when managed hooks are off', () => {
    const env: Record<string, string> = {
      WSLENV: 'KEEP/u:OPENCODE_CONFIG_DIR/p',
      OPENCODE_CONFIG_DIR: 'C:\\Users\\jin\\company-opencode'
    }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toBe('KEEP/u:OPENCODE_CONFIG_DIR/p')
    expect(env.OPENCODE_CONFIG_DIR).toBe('C:\\Users\\jin\\company-opencode')
  })
})
