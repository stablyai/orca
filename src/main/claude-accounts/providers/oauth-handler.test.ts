import { describe, expect, it } from 'vitest'
import { createOauthHandler } from './oauth-handler'
import type { ClaudeManagedAccount } from '../../../shared/types'

describe('oauthHandler.materialize', () => {
  it('returns configDirPath pointing at managedAuthPath, empty envPatch', async () => {
    const handler = createOauthHandler()
    const account: ClaudeManagedAccount = {
      id: 'a1',
      email: 'a@b.com',
      managedAuthPath: '/tmp/managed/a1/auth',
      authMethod: 'subscription-oauth',
      credentials: { authMethod: 'subscription-oauth' },
      modelMapping: {},
      fallbackAccountIds: [],
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    }
    const result = await handler.materialize(account)
    expect(result.configDirPath).toBe('/tmp/managed/a1/auth')
    expect(result.envPatch).toEqual({})
  })

  it('declares authMethod subscription-oauth', () => {
    const handler = createOauthHandler()
    expect(handler.authMethod).toBe('subscription-oauth')
  })

  it('registerAccount throws (handled by service.ts directly)', async () => {
    const handler = createOauthHandler()
    await expect(
      handler.registerAccount({
        accountId: 'a',
        managedAuthPath: '/tmp'
      })
    ).rejects.toThrow(/oauth registration/i)
  })

  it('validate returns ok without contacting network', async () => {
    const handler = createOauthHandler()
    const account: ClaudeManagedAccount = {
      id: 'a1',
      email: 'a@b.com',
      managedAuthPath: '/tmp/managed/a1/auth',
      authMethod: 'subscription-oauth',
      credentials: { authMethod: 'subscription-oauth' },
      modelMapping: {},
      fallbackAccountIds: [],
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    }
    const result = await handler.validate(account)
    expect(result.ok).toBe(true)
  })
})
