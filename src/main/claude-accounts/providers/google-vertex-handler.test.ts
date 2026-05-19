import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createGoogleVertexHandler } from './google-vertex-handler'

vi.mock('../keychain', () => ({
  writeManagedClaudeKeychainCredentials: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(async () => null),
  removeManagedClaudeKeychainCredentials: vi.fn()
}))

describe('googleVertexHandler.registerAccount', () => {
  it('records projectId + region, never writes keychain (ADC-only)', async () => {
    const handler = createGoogleVertexHandler()
    const result = await handler.registerAccount({
      accountId: 'a1',
      managedAuthPath: '/tmp/a1/auth',
      label: 'Vertex',
      secretFromUser: '',
      providerConfig: { projectId: 'my-gcp-project', region: 'us-east5' } as never
    })

    expect(result.credentials).toEqual({
      authMethod: 'google-vertex',
      projectId: 'my-gcp-project',
      region: 'us-east5'
    })
  })

  it('rejects missing projectId', async () => {
    const handler = createGoogleVertexHandler()
    await expect(
      handler.registerAccount({
        accountId: 'a1',
        managedAuthPath: '/tmp/a1/auth',
        label: 'x',
        secretFromUser: '',
        providerConfig: { region: 'us-east5' } as never
      })
    ).rejects.toThrow(/project/i)
  })

  it('rejects missing region', async () => {
    const handler = createGoogleVertexHandler()
    await expect(
      handler.registerAccount({
        accountId: 'a1',
        managedAuthPath: '/tmp/a1/auth',
        label: 'x',
        secretFromUser: '',
        providerConfig: { projectId: 'p' } as never
      })
    ).rejects.toThrow(/region/i)
  })
})
