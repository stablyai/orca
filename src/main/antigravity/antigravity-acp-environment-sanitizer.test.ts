import { describe, expect, it } from 'vitest'
import { scrubAntigravityAcpEnvironment } from './antigravity-acp-environment-sanitizer'

const launchEnv = (): Record<string, string> => ({
  GEMINI_API_KEY: 'key',
  GOOGLE_APPLICATION_CREDENTIALS: '/adc.json',
  GOOGLE_CLOUD_PROJECT: 'inherited-project',
  PATH: '/bin'
})

describe('scrubAntigravityAcpEnvironment', () => {
  it('drops inherited Google credentials for a Google sign-in', () => {
    const env = launchEnv()
    const removed = scrubAntigravityAcpEnvironment(env, {}, { method: 'oauth-personal' })
    expect(env).toEqual({ PATH: '/bin' })
    expect(removed).toContain('GEMINI_API_KEY')
  })

  it('keeps GEMINI_API_KEY for the API key account type', () => {
    const env = launchEnv()
    const removed = scrubAntigravityAcpEnvironment(env, {}, { method: 'gemini-api-key' })
    expect(env).toEqual({ GEMINI_API_KEY: 'key', PATH: '/bin' })
    expect(removed).not.toContain('GEMINI_API_KEY')
  })

  it('keeps the ADC file and project for Agent Platform', () => {
    const env = launchEnv()
    scrubAntigravityAcpEnvironment(env, {}, { method: 'agent-platform' })
    expect(env).toEqual({
      GOOGLE_APPLICATION_CREDENTIALS: '/adc.json',
      GOOGLE_CLOUD_PROJECT: 'inherited-project',
      PATH: '/bin'
    })
  })
})
