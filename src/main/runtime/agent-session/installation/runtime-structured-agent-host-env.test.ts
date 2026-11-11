import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeStructuredAgentHost } from './runtime-structured-agent-host'
import { resolveStructuredClaudeAccountHomePath } from '../environment/structured-agent-account-home'

vi.mock('../../terminal/wait/terminal-wait-visible-probe', () => ({
  OrcaRuntimeWithStartTuiIdleVisibleReadProbe: class {}
}))
afterEach(() => vi.unstubAllGlobals())

abstract class LaunchRuntime extends RuntimeStructuredAgentHost {
  configuredEnvironment() {
    return this.structuredAgentLaunchEnv('claude', {
      agentDefaultEnv: { claude: { claude_config_dir: '/configured/home' } }
    })
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
