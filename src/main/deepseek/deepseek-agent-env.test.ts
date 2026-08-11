import { afterEach, describe, expect, it, vi } from 'vitest'

const storedKey = { value: null as string | null, throws: false }

vi.mock('./deepseek-api-key-store', () => ({
  readStoredDeepSeekApiKey: () => {
    if (storedKey.throws) {
      throw new Error('undecryptable')
    }
    return storedKey.value
  }
}))

import { resolveAgentLaunchEnv, DEEPSEEK_ENV_AGENTS } from './deepseek-agent-env'

afterEach(() => {
  storedKey.value = null
  storedKey.throws = false
})

describe('resolveAgentLaunchEnv', () => {
  it('injects the stored DeepSeek key for DeepSeek-capable agents', () => {
    storedKey.value = 'sk-stored'
    expect(resolveAgentLaunchEnv('aider', null).DEEPSEEK_API_KEY).toBe('sk-stored')
    expect(resolveAgentLaunchEnv('opencode', null).DEEPSEEK_API_KEY).toBe('sk-stored')
  })

  it('does not inject for agents that do not use DeepSeek', () => {
    storedKey.value = 'sk-stored'
    expect(resolveAgentLaunchEnv('claude', null).DEEPSEEK_API_KEY).toBeUndefined()
    expect(resolveAgentLaunchEnv('codex', null).DEEPSEEK_API_KEY).toBeUndefined()
  })

  it('does not inject when no key is stored', () => {
    storedKey.value = null
    expect(resolveAgentLaunchEnv('aider', null).DEEPSEEK_API_KEY).toBeUndefined()
  })

  it('lets a user-configured agent env value win over the stored key', () => {
    storedKey.value = 'sk-stored'
    const env = resolveAgentLaunchEnv('aider', { aider: { DEEPSEEK_API_KEY: 'sk-user' } })
    expect(env.DEEPSEEK_API_KEY).toBe('sk-user')
  })

  it('never throws when the key store cannot decrypt', () => {
    storedKey.throws = true
    expect(() => resolveAgentLaunchEnv('aider', null)).not.toThrow()
    expect(resolveAgentLaunchEnv('aider', null).DEEPSEEK_API_KEY).toBeUndefined()
  })

  it('lists aider among the DeepSeek-capable agents', () => {
    expect(DEEPSEEK_ENV_AGENTS.has('aider')).toBe(true)
  })
})
