import { describe, expect, it } from 'vitest'
import type { ProviderHandler, MaterializedEnvPatch, RegisterAccountInput } from './types'

describe('ProviderHandler contract', () => {
  it('declares the required methods', () => {
    const handler: ProviderHandler = {
      authMethod: 'anthropic-api-key',
      registerAccount: async (_input: RegisterAccountInput) => {
        return {
          accountId: 'a',
          email: 'b',
          credentials: { authMethod: 'anthropic-api-key' },
          organizationUuid: null,
          organizationName: null
        }
      },
      materialize: async (_account) => {
        const patch: MaterializedEnvPatch = { envPatch: {}, configDirPath: undefined }
        return patch
      },
      validate: async (_account) => ({ ok: true })
    }
    expect(handler.authMethod).toBe('anthropic-api-key')
  })
})
