import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CodexManagedAccount, GlobalSettings } from '../../shared/types'
import {
  readStoredCodexCredentialState,
  waitForManagedCodexAuthReady
} from './managed-codex-auth-readiness'

const roots: string[] = []
const testIdToken = 'e30.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifQ.sig'
const testChatGptAuth = {
  auth_mode: 'chatgpt',
  tokens: {
    access_token: 'access',
    id_token: testIdToken,
    refresh_token: 'refresh',
    account_id: 'account'
  },
  last_refresh: '2026-07-31T00:00:00Z'
}

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('waitForManagedCodexAuthReady', () => {
  it.each([
    ['ChatGPT', testChatGptAuth],
    ['ChatGPT auth tokens', { ...testChatGptAuth, auth_mode: 'chatgptAuthTokens' }],
    ['API key', { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }],
    [
      'agent identity',
      {
        auth_mode: 'agentIdentity',
        agent_identity: { agent_runtime_id: 'runtime', agent_private_key: 'private-key' }
      }
    ],
    [
      'future agent identity storage',
      { auth_mode: 'agentIdentity', agent_identity: { future_material: 'opaque' } }
    ],
    [
      'personal access token',
      { auth_mode: 'personalAccessToken', personal_access_token: 'pat-test' }
    ],
    [
      'Bedrock API key',
      {
        auth_mode: 'bedrockApiKey',
        bedrock_api_key: { api_key: 'bedrock-key', region: 'us-east-1' }
      }
    ],
    ['future auth mode', { auth_mode: 'futureAuthMode', future_credential: { value: 'opaque' } }],
    ['future auth shape', { future_credential: { value: 'opaque' } }],
    [
      'ChatGPT with agent identity metadata',
      {
        ...testChatGptAuth,
        agent_identity: { agent_runtime_id: 'runtime', agent_private_key: 'private-key' }
      }
    ]
  ])('accepts a readable managed %s credential', (_label, auth) => {
    const fixture = createFixture()
    writeAuth(fixture.home, auth)

    expect(waitForManagedCodexAuthReady(fixture.args)).toBeUndefined()
  })

  it('waits for a missing managed credential to be restored', async () => {
    vi.useFakeTimers()
    const fixture = createFixture()
    const readiness = waitForManagedCodexAuthReady(fixture.args)

    await vi.advanceTimersByTimeAsync(50)
    writeAuth(fixture.home, { OPENAI_API_KEY: 'sk-test' })
    await vi.runAllTimersAsync()

    await expect(readiness).resolves.toBe(true)
  })

  it('waits for a partial managed ChatGPT credential to become complete', async () => {
    vi.useFakeTimers()
    const fixture = createFixture()
    writeAuth(fixture.home, {
      tokens: { access_token: 'access', id_token: testIdToken }
    })
    expect(readStoredCodexCredentialState(join(fixture.home, 'auth.json'))).toBe('incomplete')
    let resolved = false
    const readiness = waitForManagedCodexAuthReady(fixture.args)
    void readiness?.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(resolved).toBe(false)
    writeAuth(fixture.home, testChatGptAuth)
    await vi.advanceTimersByTimeAsync(25)

    await expect(readiness).resolves.toBe(true)
  })

  it('does not treat empty ChatGPT token fields as credential material', () => {
    const fixture = createFixture()
    writeAuth(fixture.home, {
      auth_mode: 'chatgpt',
      tokens: { access_token: '', id_token: '', refresh_token: '' }
    })

    expect(readStoredCodexCredentialState(join(fixture.home, 'auth.json'))).toBe('no-credential')
  })

  it('waits for an empty managed ChatGPT refresh token to be restored', async () => {
    vi.useFakeTimers()
    const fixture = createFixture()
    writeAuth(fixture.home, {
      ...testChatGptAuth,
      tokens: { ...testChatGptAuth.tokens, refresh_token: '' }
    })
    let resolved = false
    const readiness = waitForManagedCodexAuthReady(fixture.args)
    void readiness?.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(resolved).toBe(false)
    writeAuth(fixture.home, testChatGptAuth)
    await vi.advanceTimersByTimeAsync(25)

    await expect(readiness).resolves.toBe(true)
  })

  it.each([
    [
      'empty agent identity record',
      { auth_mode: 'agentIdentity', agent_identity: {} },
      {
        auth_mode: 'agentIdentity',
        agent_identity: { agent_runtime_id: 'runtime', agent_private_key: 'private-key' }
      }
    ],
    [
      'agent identity missing its private key',
      {
        auth_mode: 'agentIdentity',
        agent_identity: { agent_runtime_id: 'runtime', plan_type: 'team' }
      },
      {
        auth_mode: 'agentIdentity',
        agent_identity: { agent_runtime_id: 'runtime', agent_private_key: 'private-key' }
      }
    ],
    [
      'agent identity with an empty runtime id',
      {
        auth_mode: 'agentIdentity',
        agent_identity: { agent_runtime_id: '', agent_private_key: 'private-key' }
      },
      {
        auth_mode: 'agentIdentity',
        agent_identity: { agent_runtime_id: 'runtime', agent_private_key: 'private-key' }
      }
    ],
    [
      'object-valued personal access token',
      { auth_mode: 'personalAccessToken', personal_access_token: { token_id: 'pat' } },
      { auth_mode: 'personalAccessToken', personal_access_token: 'pat-test' }
    ],
    [
      'Bedrock metadata without an API key',
      { auth_mode: 'bedrockApiKey', bedrock_api_key: { region: 'us-east-1' } },
      {
        auth_mode: 'bedrockApiKey',
        bedrock_api_key: { api_key: 'bedrock-key', region: 'us-east-1' }
      }
    ]
  ])('waits for %s to become complete', async (_label, partial, complete) => {
    vi.useFakeTimers()
    const fixture = createFixture()
    writeAuth(fixture.home, partial)

    const readiness = waitForManagedCodexAuthReady(fixture.args)
    await vi.advanceTimersByTimeAsync(50)
    writeAuth(fixture.home, complete)
    await vi.advanceTimersByTimeAsync(25)

    await expect(readiness).resolves.toBe(true)
  })

  it('reports an unreadable managed credential after the retry window', async () => {
    vi.useFakeTimers()
    const fixture = createFixture()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(fixture.home, 'auth.json'), '{', 'utf8')

    const readiness = waitForManagedCodexAuthReady(fixture.args)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(readiness).resolves.toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(
      '[codex-auth-readiness] Managed credential remained unavailable after 1500ms'
    )
  })

  it('separates an absent credential from one that cannot be read', () => {
    const fixture = createFixture()
    expect(readStoredCodexCredentialState(join(fixture.home, 'auth.json'))).toBe('missing')

    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return
    }
    writeAuth(fixture.home, testChatGptAuth)
    chmodSync(join(fixture.home, 'auth.json'), 0o000)
    expect(readStoredCodexCredentialState(join(fixture.home, 'auth.json'))).toBe('unreadable')
  })

  it('does not gate system, WSL, or unmanaged custom homes', async () => {
    const fixture = createFixture()
    await waitForManagedCodexAuthReady({
      ...fixture.args,
      codexHomePath: join(fixture.root, 'custom-home')
    })
    await waitForManagedCodexAuthReady({
      ...fixture.args,
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })
    await waitForManagedCodexAuthReady({
      ...fixture.args,
      codexHomePath: null
    })
  })
})

function createFixture(): {
  root: string
  home: string
  args: Parameters<typeof waitForManagedCodexAuthReady>[0]
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-managed-codex-auth-'))
  roots.push(root)
  const home = join(root, 'account', 'home')
  mkdirSync(home, { recursive: true })
  const account = {
    id: 'account-1',
    managedHomePath: home,
    managedHomeRuntime: 'host'
  } as CodexManagedAccount
  return {
    root,
    home,
    args: {
      codexHomePath: home,
      settings: { codexManagedAccounts: [account] } as GlobalSettings,
      target: { runtime: 'host' }
    }
  }
}

function writeAuth(home: string, auth: object): void {
  writeFileSync(join(home, 'auth.json'), JSON.stringify(auth), { mode: 0o600 })
}
