import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareLocalCommitMessageAgentEnv } from './commit-message-agent-environment'

describe('prepareLocalCommitMessageAgentEnv (Claude)', () => {
  // Snapshot/restore the provider env keys the helper may strip — keeps the
  // test isolated from whatever the developer machine has set.
  const ENV_KEYS_TO_SNAPSHOT = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CONFIG_DIR'
  ] as const
  const snapshot: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS_TO_SNAPSHOT) {
      snapshot[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS_TO_SNAPSHOT) {
      const prior = snapshot[key]
      if (prior === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = prior
      }
    }
  })

  it('uses applyEnvFromMaterialization when preparation.materialization is set (non-OAuth provider)', async () => {
    // Seed a stale provider key to prove it gets stripped.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'stale-oauth-token'

    const result = await prepareLocalCommitMessageAgentEnv('claude', {
      prepareForClaudeLaunch: async () => ({
        configDir: '/tmp/claude',
        envPatch: {},
        stripAuthEnv: true,
        provenance: 'managed:api-key-account',
        materialization: {
          envPatch: {
            ANTHROPIC_API_KEY: 'sk-ant-test-1234'
          }
        }
      })
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.env).toBeDefined()
    expect(result.env!.ANTHROPIC_API_KEY).toBe('sk-ant-test-1234')
    // Stale provider env got stripped by the allowlist-replace path.
    expect(result.env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('falls back to applyClaudeEnvPatch when preparation.materialization is undefined (OAuth)', async () => {
    const result = await prepareLocalCommitMessageAgentEnv('claude', {
      prepareForClaudeLaunch: async () => ({
        configDir: '/tmp/claude-oauth',
        envPatch: { CLAUDE_CONFIG_DIR: '/tmp/claude-oauth' },
        stripAuthEnv: true,
        provenance: 'managed:oauth-account'
      })
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.env).toBeDefined()
    expect(result.env!.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-oauth')
    // OAuth path does not inject ANTHROPIC_API_KEY.
    expect(result.env!.ANTHROPIC_API_KEY).toBeUndefined()
  })
})

