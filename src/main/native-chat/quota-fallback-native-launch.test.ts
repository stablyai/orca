import { expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from './agent-session-record-test-fixture'
import {
  createClaudeStructuredLaunchResolver,
  createCodexStructuredLaunchResolver
} from '../runtime/structured-agent-launch-composition.test-support'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { quotaApiEnvironment } from './quota-fallback-native-auth'

const identity = {
  sessionId: 'quota-session',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'claude' as const,
  providerHandle: null
}
it('keeps Claude transcript home and permission context while selecting isolated API auth', async () => {
  const handle = claudeProviderHandle('12345678-1234-1234-1234-123456789012', null)
  const record = agentSessionRecordFixture({
    sessionId: identity.sessionId,
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/tmp/quota-test-home/.claude' },
    providerHandleChain: [
      { linkId: 'link', handle, origin: 'created', mintedAtFence: 1, observedAt: 1 }
    ]
  })
  const inherited = {
    PATH: '/usr/bin',
    CLAUDE_CONFIG_DIR: '/tmp/quota-test-home/.claude',
    CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '0',
    ANTHROPIC_BASE_URL: 'https://invalid.example'
  }
  const resolve = createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async () => '/repo',
    resolveCommand: () => ({ command: '/usr/bin/claude', prefixArgs: [] }),
    resolveAuthPolicy: () => ({ account: 'system' }),
    resolveInheritedEnv: async () => inherited,
    hasTranscript: async () => true,
    resolveLaunchArgs: () => [],
    resolveQuotaApiCredential: async () => ({
      route: 'claude-api',
      apiKey: 'fake-key',
      maxDebitUsd: 1
    })
  })
  const launch = await resolve({
    identity: { ...identity, providerHandle: handle },
    permissionMode: 'ask'
  })
  expect(launch.options.resume).toBe(handle.nativeId)
  expect(launch.options.extraArgs).toMatchObject({ 'max-budget-usd': '1' })
  expect(launch.claudeConfigDir).toBe('/tmp/quota-test-home/.claude')
  expect(launch.env).toMatchObject({
    ANTHROPIC_API_KEY: 'fake-key',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1'
  })
  expect(
    quotaApiEnvironment(inherited, { route: 'claude-api', apiKey: 'fake-key', maxDebitUsd: 1 })
      .removed
  ).not.toContain('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST')
  expect(launch.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
  expect(launch.env).not.toHaveProperty('ANTHROPIC_BASE_URL')
  expect(inherited.CLAUDE_CODE_OAUTH_TOKEN).toBe('fake-oauth')
})
it('resumes the same Codex thread with a keyed API provider, then explicitly restores subscription routing', async () => {
  const handle = codexProviderHandle('019fd532-7c11-7a90-b6de-4e1a2c3d5f60')
  const record = agentSessionRecordFixture({
    sessionId: identity.sessionId,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/tmp/quota-test-home/.codex' },
    providerHandleChain: [
      { linkId: 'link', handle, origin: 'created', mintedAtFence: 1, observedAt: 1 }
    ]
  })
  let api = true
  const resolve = createCodexStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async () => '/repo',
    resolveCommand: () => ({ command: '/usr/bin/codex', prefixArgs: [] }),
    resolveLaunchArgs: () => [],
    resolveEnvironment: async () => ({ OPENAI_API_KEY: 'fake-old' }),
    resolveQuotaApiCredential: async () =>
      api ? { route: 'openai-api', apiKey: 'fake-key', maxDebitUsd: 1 } : null,
    restoreQuotaOpenaiSubscription: () => !api
  })
  const launch = await resolve({
    identity: { ...identity, agent: 'codex', providerHandle: handle }
  })
  expect(launch.resumeThreadId).toBe(handle.nativeId)
  expect(launch.codexHome).toBe('/tmp/quota-test-home/.codex')
  expect(launch.modelProvider).toBe('orca_quota_api')
  expect(launch.args).toContain('model_providers.orca_quota_api.requires_openai_auth=false')
  expect(launch.args.join(' ')).not.toContain('fake-key')
  expect(launch.env).toMatchObject({ ORCA_QUOTA_API_KEY: 'fake-key' })
  expect(launch.env).not.toHaveProperty('OPENAI_API_KEY')
  api = false
  const restored = await resolve({
    identity: { ...identity, agent: 'codex', providerHandle: handle }
  })
  expect(restored.modelProvider).toBe('openai')
  expect(restored.args).toContain('model_provider="openai"')
  expect(restored.env).not.toHaveProperty('ORCA_QUOTA_API_KEY')
})
it('rejects multiline credentials without rejecting ordinary key letters', () => {
  expect(() =>
    quotaApiEnvironment({}, { route: 'claude-api', apiKey: 'contains-r-and-n', maxDebitUsd: 1 })
  ).not.toThrow()
  expect(() =>
    quotaApiEnvironment({}, { route: 'claude-api', apiKey: 'fake\nkey', maxDebitUsd: 1 })
  ).toThrow()
})
