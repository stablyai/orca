import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeStructuredAgentHost } from './runtime-structured-agent-host'
import { resolveStructuredClaudeAccountHomePath } from '../environment/structured-agent-account-home'

vi.mock('../../terminal/wait/terminal-wait-visible-probe', () => ({
  OrcaRuntimeWithStartTuiIdleVisibleReadProbe: class {}
}))
vi.mock('../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/orca/data'
}))
afterEach(() => vi.unstubAllGlobals())

abstract class LaunchRuntime extends RuntimeStructuredAgentHost {
  configuredEnvironment() {
    return this.structuredAgentLaunchEnv('claude', {
      agentDefaultEnv: { claude: { claude_config_dir: '/configured/home' } }
    })
  }

  claudeAuthPolicy() {
    return this.structuredAgentCatalogDependencies().resolveClaudeAuthPolicy()
  }
}

it('uses the same configured Windows home for account identity, then honors the host account', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  let host: Record<string, string> = {}
  const runtime: LaunchRuntime = Object.assign(Object.create(LaunchRuntime.prototype), {
    accounts: { hostLaunchEnvFor: () => host }
  })
  const accountHome = () =>
    resolveStructuredClaudeAccountHomePath({
      launchEnv: runtime.configuredEnvironment(),
      wslDistro: null,
      getClaudeConfigDirectory: () => '/fallback/home'
    })
  expect(await accountHome()).toBe('/configured/home')
  host = { CLAUDE_CONFIG_DIR: '/host/home' }
  expect(runtime.configuredEnvironment()).toEqual({ CLAUDE_CONFIG_DIR: '/host/home' })
  expect(await accountHome()).toBe('/host/home')
})

// A WSL host has no account services: the owning desktop pushes the selected account's env.
// Calling such a chat's account "system" makes Sign in log the distro's own ~/.claude in instead.
it('names the account a desktop-pushed Claude folder runs under, so sign-in targets that account', async () => {
  let host: Record<string, string> = {}
  const runtime = Object.assign(Object.create(LaunchRuntime.prototype), {
    accounts: { hostLaunchEnvFor: (agent: string | null) => (agent === 'claude' ? host : {}) },
    requireStore: () => ({
      getSettings: () => ({ claudeManagedAccounts: [], activeClaudeManagedAccountId: null })
    })
  }) as LaunchRuntime
  const policy = () => runtime.claudeAuthPolicy()
  expect(await policy()).toEqual({ account: 'system' })
  host = {
    ORCA_CLAUDE_PROFILE_POINTER: '~/.orca/claude-profiles/selected',
    CLAUDE_CONFIG_DIR: '/home/me/.orca/claude-profiles/a/home',
    ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/home/me/.orca/claude-profiles/a/home'
  }
  expect(await policy()).toEqual({ account: 'managed' })
  // System default keeps only the pointer a typed `claude` follows.
  host = { ORCA_CLAUDE_PROFILE_POINTER: '~/.orca/claude-profiles/selected' }
  expect(await policy()).toEqual({ account: 'system' })
})
