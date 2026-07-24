import { describe, expect, it } from 'vitest'
import { addOrcaWslInteropEnv, addWorktreeSetupWslInteropEnv } from './wsl-orca-env'

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

  it('tags pre-translated Linux setup paths /u so WSLENV does not translate them again (#9206)', () => {
    const env: Record<string, string> = {
      ORCA_ROOT_PATH: '/home/jin/repo',
      ORCA_WORKTREE_PATH: '/home/jin/repo-worktrees/fix-1',
      ORCA_WORKSPACE_NAME: 'fix-1',
      CONDUCTOR_ROOT_PATH: '/home/jin/repo',
      GHOSTX_ROOT_PATH: '/home/jin/repo'
    }

    addOrcaWslInteropEnv(env)

    // /u (not /p): hooks.ts already converted these to Linux paths before
    // spawn, so a /p flag would make WSLENV double-translate them.
    expect(env.WSLENV).toContain('ORCA_ROOT_PATH/u')
    expect(env.WSLENV).toContain('ORCA_WORKTREE_PATH/u')
    expect(env.WSLENV).toContain('CONDUCTOR_ROOT_PATH/u')
    expect(env.WSLENV).toContain('GHOSTX_ROOT_PATH/u')
    expect(env.WSLENV).not.toContain('ORCA_ROOT_PATH/p')
    expect(env.WSLENV).not.toContain('ORCA_WORKTREE_PATH/p')
    // The value itself must stay the already-Linux path.
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

    expect(env.WSLENV).toBe('ORCA_WORKSPACE_NAME/u')
  })

  it('does not register setup vars that are absent from the env', () => {
    const env: Record<string, string> = { ORCA_TERMINAL_HANDLE: 'term_wsl' }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toBe('ORCA_TERMINAL_HANDLE/u')
  })

  it('marks the WSL hook relay version for import on relay spawn envs', () => {
    const env: Record<string, string> = { ORCA_WSL_HOOK_RELAY_VERSION: '0.1.0+abc' }
    addOrcaWslInteropEnv(env)
    expect(env.WSLENV).toBe('ORCA_WSL_HOOK_RELAY_VERSION/u')
  })
})

describe('addWorktreeSetupWslInteropEnv', () => {
  it('registers only setup vars, sharing the /u-vs-/p flag logic with the PTY path (#9206)', () => {
    const env: Record<string, string | undefined> = {
      ORCA_ROOT_PATH: '/mnt/c/Users/jin/repo',
      ORCA_WORKTREE_PATH: 'C:\\Users\\jin\\repo-worktrees\\fix-1',
      ORCA_WORKSPACE_NAME: 'fix-1',
      // Terminal-only vars must not leak into runHook's WSLENV.
      ORCA_TERMINAL_HANDLE: 'term_wsl'
    }

    addWorktreeSetupWslInteropEnv(env)

    expect(env.WSLENV).toBe('ORCA_ROOT_PATH/u:ORCA_WORKTREE_PATH/p:ORCA_WORKSPACE_NAME/u')
  })
})
