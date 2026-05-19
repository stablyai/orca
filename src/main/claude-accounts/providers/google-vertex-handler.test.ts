import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createGoogleVertexHandler } from './google-vertex-handler'
import type { ClaudeManagedAccount } from '../../../shared/types'

vi.mock('../keychain', () => ({
  writeManagedClaudeKeychainCredentials: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(async () => null),
  removeManagedClaudeKeychainCredentials: vi.fn()
}))

function vertexAccount(): ClaudeManagedAccount {
  return {
    id: 'a1',
    email: 'Vertex',
    managedAuthPath: '/tmp/a1/auth',
    authMethod: 'google-vertex',
    credentials: {
      authMethod: 'google-vertex',
      projectId: 'my-gcp',
      region: 'us-east5'
    },
    modelMapping: {},
    fallbackAccountIds: [],
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

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

describe('googleVertexHandler.materialize', () => {
  it('emits USE_VERTEX, projectId, region, default models', async () => {
    const handler = createGoogleVertexHandler()
    const out = await handler.materialize(vertexAccount())

    expect(out.envPatch.CLAUDE_CODE_USE_VERTEX).toBe('1')
    expect(out.envPatch.ANTHROPIC_VERTEX_PROJECT_ID).toBe('my-gcp')
    expect(out.envPatch.CLOUD_ML_REGION).toBe('us-east5')
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-7')
    expect(out.envPatch.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-6')
    expect(out.envPatch.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5@20251001')
  })

  it('"global" region passes through to CLOUD_ML_REGION', async () => {
    const handler = createGoogleVertexHandler()
    const acct = vertexAccount()
    if (acct.credentials.authMethod !== 'google-vertex') throw new Error('bad fixture')
    acct.credentials.region = 'global'
    const out = await handler.materialize(acct)
    expect(out.envPatch.CLOUD_ML_REGION).toBe('global')
  })

  it('per-account modelMapping overrides defaults', async () => {
    const handler = createGoogleVertexHandler()
    const acct = vertexAccount()
    acct.modelMapping = { opus: 'claude-opus-4-7-preview' }
    const out = await handler.materialize(acct)
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-7-preview')
  })

  it('never emits a token env var (ADC-only)', async () => {
    const handler = createGoogleVertexHandler()
    const out = await handler.materialize(vertexAccount())
    expect(out.envPatch.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(out.envPatch.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
  })
})
