import { describe, expect, it, vi } from 'vitest'
import { observeCodexProfileLaunchAuthority } from './profile-launch-authority'
import type { CodexAppServerInvocation } from '../codex/codex-app-server-session'
const snapshot = {
  id: 'a',
  name: 'A',
  agent: 'codex',
  hostId: 'local',
  executable: '/tools/provider',
  binding: { kind: 'managed', accountId: 'a' },
  resolvedHome: '/accounts/a',
  identity: { kind: 'verified', subject: 'a', displayName: 'a@example.test' }
} as const
const config = {
  model_provider: 'openai',
  cli_auth_credentials_store: 'file',
  forced_login_method: 'chatgpt'
}
function probe(responses: Record<string, unknown>) {
  const requests = vi.fn(async (method: string) => responses[method])
  const invocations: CodexAppServerInvocation[] = []
  const runSession = async <T>(
    invocation: CodexAppServerInvocation,
    body: (rpc: { request: typeof requests; notify: () => void }) => Promise<T>
  ): Promise<T> => {
    invocations.push(invocation)
    return body({ request: requests, notify: () => {} })
  }
  return { runSession, requests, invocations }
}
const valid = () => ({
  'config/read': { config, origins: {}, layers: [] },
  'configRequirements/read': { requirements: null },
  'account/read': {
    account: { type: 'chatgpt', email: 'a@example.test' },
    requiresOpenaiAuth: true
  }
})
describe('managed Codex effective launch authority', () => {
  it.each(['openai', null])(
    'inspects cwd, policy and account without login or refresh (provider: %s)',
    async (modelProvider) => {
      const responses = valid()
      const p = probe({
        ...responses,
        'config/read': {
          ...responses['config/read'],
          config: { ...config, model_provider: modelProvider }
        }
      })
      await observeCodexProfileLaunchAuthority(
        { snapshot, cwd: '/workspace', env: { CODEX_HOME: '/accounts/a' } },
        p.runSession
      )
      expect(p.invocations[0]).toMatchObject({
        command: '/tools/provider',
        cwd: '/workspace',
        timeoutMs: 8000,
        maxOutputBytes: 1024 * 1024,
        env: { CODEX_HOME: '/accounts/a' }
      })
      expect(p.requests.mock.calls).toEqual([
        ['config/read', { cwd: '/workspace', includeLayers: true }],
        ['configRequirements/read', {}],
        ['account/read', { refreshToken: false }]
      ])
    }
  )
  it('accepts the provider built-in ChatGPT endpoint when no configuration source sets it', async () => {
    const p = probe({
      ...valid(),
      'config/read': {
        config: { ...config, chatgpt_base_url: 'https://chatgpt.com/backend-api/' },
        origins: {},
        layers: [{ name: { type: 'user' }, config: {} }]
      }
    })
    await expect(
      observeCodexProfileLaunchAuthority({ snapshot, cwd: '/workspace', env: {} }, p.runSession)
    ).resolves.toBeUndefined()
  })
  it.each([
    { origins: { chatgpt_base_url: { name: { type: 'system' } } }, layers: [] },
    {
      origins: {},
      layers: [
        { name: { type: 'user' }, config: { chatgpt_base_url: 'https://chatgpt.com/backend-api/' } }
      ]
    }
  ])(
    'refuses explicit endpoint ownership even when it matches the built-in URL: %j',
    async (sources) => {
      const p = probe({
        ...valid(),
        'config/read': {
          config: { ...config, chatgpt_base_url: 'https://chatgpt.com/backend-api/' },
          ...sources
        }
      })
      await expect(
        observeCodexProfileLaunchAuthority({ snapshot, cwd: '/workspace', env: {} }, p.runSession)
      ).rejects.toMatchObject({ code: 'codex_config' })
      expect(p.requests).not.toHaveBeenCalledWith('account/read', expect.anything())
    }
  )
  it.each([
    { model_provider: 'custom' },
    { model_providers: { openai: { base_url: 'SECRET_SENTINEL' } } },
    { openai_base_url: 'SECRET_SENTINEL' },
    { chatgpt_base_url: 'https://example.invalid/backend-api/' },
    { cli_auth_credentials_store: 'keyring' },
    { forced_chatgpt_workspace_id: 'workspace-other' },
    { forced_chatgpt_workspace_id: ['workspace-other'] }
  ])('refuses effective workspace/provider routing %j', async (override) => {
    const p = probe({
      ...valid(),
      'config/read': { config: { ...config, ...override }, origins: {}, layers: [] }
    })
    await expect(
      observeCodexProfileLaunchAuthority({ snapshot, cwd: '/workspace', env: {} }, p.runSession)
    ).rejects.toThrow(/direct OpenAI OAuth/)
    expect(p.requests).not.toHaveBeenCalledWith('account/read', expect.anything())
  })
  it.each(['system', 'user', 'project', 'mdm'])(
    'refuses original %s workspace restrictions even if effective config hides them',
    async (type) => {
      const p = probe({
        ...valid(),
        'config/read': {
          config,
          origins: {},
          layers: [{ name: { type }, config: { forced_chatgpt_workspace_id: 'other' } }]
        }
      })
      await expect(
        observeCodexProfileLaunchAuthority({ snapshot, cwd: '/workspace', env: {} }, p.runSession)
      ).rejects.toMatchObject({ code: 'codex_config' })
      expect(p.requests).not.toHaveBeenCalledWith('account/read', expect.anything())
    }
  )
  it.each(['forcedChatgptWorkspaceId', 'forced_chatgpt_workspace_id'])(
    'refuses workspace restrictions in requirements field %s',
    async (key) => {
      const p = probe({
        ...valid(),
        'configRequirements/read': { requirements: { [key]: 'other' } }
      })
      await expect(
        observeCodexProfileLaunchAuthority({ snapshot, cwd: '/workspace', env: {} }, p.runSession)
      ).rejects.toMatchObject({ code: 'codex_config' })
      expect(p.requests).not.toHaveBeenCalledWith('account/read', expect.anything())
    }
  )
  it('ignores disabled workspace restrictions and accepts absent effective restrictions', async () => {
    const p = probe({
      ...valid(),
      'config/read': {
        config: { ...config, forced_chatgpt_workspace_id: null },
        origins: {},
        layers: [
          {
            name: { type: 'project' },
            config: { forced_chatgpt_workspace_id: 'other' },
            disabledReason: 'untrusted'
          }
        ]
      }
    })
    await expect(
      observeCodexProfileLaunchAuthority({ snapshot, cwd: '/workspace', env: {} }, p.runSession)
    ).resolves.toBeUndefined()
  })
  it('refuses enterprise auth routing even when config looks ordinary', async () => {
    const p = probe({
      ...valid(),
      'configRequirements/read': { requirements: { cliAuthCredentialsStore: 'keyring' } }
    })
    await expect(
      observeCodexProfileLaunchAuthority({ snapshot, cwd: '/workspace', env: {} }, p.runSession)
    ).rejects.toThrow(/direct OpenAI OAuth/)
  })
  it.each([
    { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
    { account: { type: 'chatgpt', email: 'other' }, requiresOpenaiAuth: true }
  ])('refuses wrong active account %j', async (account) => {
    const p = probe({ ...valid(), 'account/read': account })
    await expect(
      observeCodexProfileLaunchAuthority({ snapshot, cwd: '/workspace', env: {} }, p.runSession)
    ).rejects.toThrow(/verify/)
  })
  it('sanitizes failures and refuses missing effective-policy capability', async () => {
    const p = probe({})
    await expect(
      observeCodexProfileLaunchAuthority({ snapshot, cwd: '/workspace', env: {} }, p.runSession)
    ).rejects.toThrow(/verify/)
    await expect(
      observeCodexProfileLaunchAuthority({ snapshot, cwd: '/workspace', env: {} }, async () => {
        throw new Error('SECRET_SENTINEL')
      })
    ).rejects.not.toThrow('SECRET_SENTINEL')
  })
  it('refuses inherited endpoints before starting a child and skips external entirely', async () => {
    const p = probe(valid())
    await expect(
      observeCodexProfileLaunchAuthority(
        { snapshot, cwd: '/workspace', env: { OPENAI_BASE_URL: 'SECRET_SENTINEL' } },
        p.runSession
      )
    ).rejects.toThrow(/direct OpenAI OAuth/)
    await observeCodexProfileLaunchAuthority(
      {
        snapshot: { ...snapshot, binding: { kind: 'external', home: '/external' } },
        cwd: '/workspace',
        env: { OPENAI_BASE_URL: 'external' }
      },
      p.runSession
    )
    expect(p.invocations).toHaveLength(0)
  })
})
