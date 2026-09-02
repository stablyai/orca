import { afterEach, describe, expect, it } from 'vitest'
import { shouldUseAiVaultServiceProcess } from './session-scanner-background'

const originalBackend = process.env.ORCA_AI_VAULT_SERVICE_PROCESS
const originalNodeEnv = process.env.NODE_ENV

afterEach(() => {
  if (originalBackend === undefined) {
    delete process.env.ORCA_AI_VAULT_SERVICE_PROCESS
  } else {
    process.env.ORCA_AI_VAULT_SERVICE_PROCESS = originalBackend
  }
  process.env.NODE_ENV = originalNodeEnv
})

describe('shouldUseAiVaultServiceProcess', () => {
  it('keeps unit tests on the worker fallback by default', () => {
    delete process.env.ORCA_AI_VAULT_SERVICE_PROCESS
    process.env.NODE_ENV = 'test'
    expect(shouldUseAiVaultServiceProcess()).toBe(false)
  })

  it('defaults non-test hosts to the service process', () => {
    delete process.env.ORCA_AI_VAULT_SERVICE_PROCESS
    process.env.NODE_ENV = 'production'
    expect(shouldUseAiVaultServiceProcess()).toBe(true)
  })

  it.each([
    ['1', true],
    ['0', false]
  ] as const)('honors the explicit %s kill switch', (value, expected) => {
    process.env.ORCA_AI_VAULT_SERVICE_PROCESS = value
    expect(shouldUseAiVaultServiceProcess()).toBe(expected)
  })
})
