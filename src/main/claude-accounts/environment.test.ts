import { describe, expect, it } from 'vitest'
import { applyEnvFromMaterialization, PROVIDER_ENV_KEYS } from './environment'

describe('applyEnvFromMaterialization', () => {
  it('removes every key in PROVIDER_ENV_KEYS before re-emitting', () => {
    const baseEnv: Record<string, string> = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'leftover',
      ANTHROPIC_AUTH_TOKEN: 'leftover2',
      AWS_BEARER_TOKEN_BEDROCK: 'leftover3',
      CLAUDE_CODE_USE_BEDROCK: '1'
    }
    const out = applyEnvFromMaterialization(baseEnv, {
      envPatch: { ANTHROPIC_API_KEY: 'fresh' }
    })
    expect(out.ANTHROPIC_API_KEY).toBe('fresh')
    expect(out.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(out.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
    expect(out.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(out.PATH).toBe('/usr/bin')
  })

  it('emits configDirPath as CLAUDE_CONFIG_DIR when present', () => {
    const out = applyEnvFromMaterialization(
      {},
      {
        envPatch: {},
        configDirPath: '/tmp/managed'
      }
    )
    expect(out.CLAUDE_CONFIG_DIR).toBe('/tmp/managed')
  })

  it('PROVIDER_ENV_KEYS includes every known provider key', () => {
    expect(PROVIDER_ENV_KEYS).toEqual(
      expect.arrayContaining([
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'AWS_BEARER_TOKEN_BEDROCK',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_FOUNDRY'
      ])
    )
  })

  it('removes ANTHROPIC_CUSTOM_HEADERS when value looks auth-like', () => {
    const baseEnv = { ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: leftover' }
    const out = applyEnvFromMaterialization(baseEnv, { envPatch: {} })
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  it('preserves ANTHROPIC_CUSTOM_HEADERS when re-emitted from patch', () => {
    const baseEnv = {}
    const out = applyEnvFromMaterialization(baseEnv, {
      envPatch: { ANTHROPIC_CUSTOM_HEADERS: 'x-trace-id: abc' }
    })
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe('x-trace-id: abc')
  })
})
