import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoverCommitMessageModelsResult } from '../source-control-text-generation-types'
import { notifyAgentsRefreshedOnHost } from '../../preflight/agents-refreshed-on-host'
import {
  discoverModelsWithHostCache,
  modelDiscoveryHostCacheKey
} from './model-discovery-host-cache'

const claudeResult: DiscoverCommitMessageModelsResult = {
  success: true,
  catalogOrigin: 'probe',
  defaultModelId: 'sonnet',
  models: [{ id: 'sonnet', label: 'Sonnet' }],
  capability: {
    id: 'claude',
    label: 'Claude',
    modelSource: 'dynamic',
    defaultModelId: 'sonnet',
    models: [{ id: 'sonnet', label: 'Sonnet' }]
  }
}

const claudeInput = {
  agentId: 'claude' as const,
  agentCommandOverride: undefined,
  env: { CLAUDE_CONFIG_DIR: '/accounts/claude-a' },
  options: {}
}

beforeEach(() => {
  notifyAgentsRefreshedOnHost(false)
})

describe('discoverModelsWithHostCache for Claude', () => {
  it('reuses one in-flight probe and then the cached list for the same account', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const probe = vi.fn(() => gate.then(() => claudeResult))

    const first = discoverModelsWithHostCache(claudeInput, probe)
    const second = discoverModelsWithHostCache(claudeInput, probe)
    await Promise.resolve()
    expect(probe).toHaveBeenCalledTimes(1)
    release()
    await expect(first).resolves.toEqual(claudeResult)
    await expect(second).resolves.toEqual(claudeResult)

    await expect(discoverModelsWithHostCache(claudeInput, probe)).resolves.toEqual(claudeResult)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('probes again for another Claude account and after an agent refresh', async () => {
    const probe = vi.fn(async () => claudeResult)
    await discoverModelsWithHostCache(claudeInput, probe)
    await discoverModelsWithHostCache(
      { ...claudeInput, env: { CLAUDE_CONFIG_DIR: '/accounts/claude-b' } },
      probe
    )
    expect(probe).toHaveBeenCalledTimes(2)

    notifyAgentsRefreshedOnHost(true)
    await discoverModelsWithHostCache(claudeInput, probe)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('does not start a second probe on the host when discovery is repeated while the cache is warm', async () => {
    const probe = vi.fn(async () => claudeResult)
    await discoverModelsWithHostCache(claudeInput, probe)
    await discoverModelsWithHostCache(claudeInput, probe)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('probes again when Claude routing or auth changes in the same config dir', async () => {
    const probe = vi.fn(async () => claudeResult)
    const env = { CLAUDE_CONFIG_DIR: '/accounts/claude-a', ANTHROPIC_BASE_URL: 'https://a.example' }
    await discoverModelsWithHostCache({ ...claudeInput, env }, probe)
    await discoverModelsWithHostCache(
      { ...claudeInput, env: { ...env, ANTHROPIC_BASE_URL: 'https://b.example' } },
      probe
    )
    await discoverModelsWithHostCache(
      { ...claudeInput, env: { ...env, ANTHROPIC_AUTH_TOKEN: 'token-a' } },
      probe
    )
    await discoverModelsWithHostCache(
      { ...claudeInput, env: { ...env, ANTHROPIC_AUTH_TOKEN: 'token-b' } },
      probe
    )
    expect(probe).toHaveBeenCalledTimes(4)
  })

  it('misses the SSH cache when agentDefaultEnv changes and never stores the secret', async () => {
    const secret = 'super-secret-token'
    const override = `ANTHROPIC_API_KEY=${secret} claude`
    const probe = vi.fn(async () => claudeResult)
    const env = { ANTHROPIC_AUTH_TOKEN: secret, ANTHROPIC_BASE_URL: 'https://a.example' }
    const first = {
      ...claudeInput,
      agentCommandOverride: override,
      env,
      launchEnv: { ANTHROPIC_AUTH_TOKEN: secret, ANTHROPIC_BASE_URL: 'https://a.example' },
      options: { cwd: '/srv/app' },
      connectionId: 'box'
    }
    const key = modelDiscoveryHostCacheKey(first)
    expect(key).toBeTruthy()
    expect(key).not.toContain(secret)
    expect(key).not.toContain(override)
    await discoverModelsWithHostCache(first, probe)
    await discoverModelsWithHostCache(
      {
        ...first,
        launchEnv: { ANTHROPIC_AUTH_TOKEN: secret, ANTHROPIC_BASE_URL: 'https://b.example' }
      },
      probe
    )
    expect(probe).toHaveBeenCalledTimes(2)
    expect(modelDiscoveryHostCacheKey(first)).not.toContain(secret)
  })

  it('misses when an account header changes and when an explicit empty value is set', async () => {
    const header = 'x-api-key secret-header'
    const probe = vi.fn(async () => claudeResult)
    const first = {
      ...claudeInput,
      accountPatch: { ANTHROPIC_CUSTOM_HEADERS: header }
    }
    const key = modelDiscoveryHostCacheKey(first)
    expect(key).toBeTruthy()
    expect(key).not.toContain(header)
    expect(key).not.toContain('secret-header')
    await discoverModelsWithHostCache(first, probe)
    await discoverModelsWithHostCache(
      { ...first, accountPatch: { ANTHROPIC_CUSTOM_HEADERS: 'x-api-key other-header' } },
      probe
    )
    expect(probe).toHaveBeenCalledTimes(2)
    const empty = modelDiscoveryHostCacheKey({
      ...claudeInput,
      launchEnv: { ANTHROPIC_CUSTOM_HEADERS: '' }
    })
    const unset = modelDiscoveryHostCacheKey({ ...claudeInput, launchEnv: {} })
    expect(empty).not.toBe(unset)
    expect(empty).not.toContain('ANTHROPIC_CUSTOM_HEADERS')
  })

  it('hashes account and workspace paths so a directory marker never appears in the key', async () => {
    const marker = 'synthetic-account-dir-marker'
    const probe = vi.fn(async () => claudeResult)
    const first = {
      ...claudeInput,
      env: { CLAUDE_CONFIG_DIR: `/tmp/${marker}/claude-a` },
      options: { cwd: `/home/${marker}/repo` },
      connectionId: 'box'
    }
    const key = modelDiscoveryHostCacheKey(first)
    expect(key).toBeTruthy()
    expect(key).not.toContain(marker)
    const codex = modelDiscoveryHostCacheKey({
      agentId: 'codex',
      agentCommandOverride: undefined,
      env: { CODEX_HOME: `/tmp/${marker}/codex` },
      options: { cwd: `/srv/${marker}` },
      connectionId: 'box'
    })
    expect(codex).toBeTruthy()
    expect(codex).not.toContain(marker)
    await discoverModelsWithHostCache(first, probe)
    await discoverModelsWithHostCache(
      { ...first, env: { CLAUDE_CONFIG_DIR: `/tmp/${marker}/claude-b` } },
      probe
    )
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('misses when login-shell ANTHROPIC_CUSTOM_HEADERS changes, including empty versus unset', async () => {
    const header = 'Authorization: Bearer login-shell-secret'
    const probe = vi.fn(async () => claudeResult)
    const withHeader = {
      ...claudeInput,
      env: { ...claudeInput.env, ANTHROPIC_CUSTOM_HEADERS: header }
    }
    const key = modelDiscoveryHostCacheKey(withHeader)
    expect(key).toBeTruthy()
    expect(key).not.toContain(header)
    expect(key).not.toContain('login-shell-secret')
    await discoverModelsWithHostCache(withHeader, probe)
    await discoverModelsWithHostCache(
      {
        ...withHeader,
        env: { ...withHeader.env, ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer other-secret' }
      },
      probe
    )
    expect(probe).toHaveBeenCalledTimes(2)
    const empty = modelDiscoveryHostCacheKey({
      ...claudeInput,
      env: { ...claudeInput.env, ANTHROPIC_CUSTOM_HEADERS: '' }
    })
    const unset = modelDiscoveryHostCacheKey(claudeInput)
    expect(empty).not.toBe(unset)
    expect(empty).not.toContain('ANTHROPIC_CUSTOM_HEADERS')
  })
})
