import { describe, expect, it } from 'vitest'
import { migrateClaudeAccount } from './migration'

describe('migrateClaudeAccount', () => {
  it('synthesizes credentials, modelMapping, fallbackAccountIds for legacy subscription-oauth', () => {
    const legacy = {
      id: 'a1',
      email: 'a@b.com',
      managedAuthPath: '/tmp/a',
      authMethod: 'subscription-oauth' as const,
      organizationUuid: null,
      organizationName: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const migrated = migrateClaudeAccount(legacy as never)
    expect(migrated.credentials).toEqual({ authMethod: 'subscription-oauth' })
    expect(migrated.modelMapping).toEqual({})
    expect(migrated.fallbackAccountIds).toEqual([])
  })

  it('passes through accounts that already have new fields', () => {
    const fresh = {
      id: 'a1',
      email: 'a@b.com',
      managedAuthPath: '/tmp/a',
      authMethod: 'anthropic-api-key' as const,
      credentials: { authMethod: 'anthropic-api-key' as const },
      modelMapping: { opus: 'claude-opus-4-7' },
      fallbackAccountIds: ['b'],
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const migrated = migrateClaudeAccount(fresh)
    expect(migrated).toEqual(fresh)
  })

  it('coerces unknown authMethod to "unknown" credentials', () => {
    const legacy = {
      id: 'a1',
      email: 'a@b.com',
      managedAuthPath: '/tmp/a',
      authMethod: 'unknown' as const,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const migrated = migrateClaudeAccount(legacy as never)
    expect(migrated.credentials).toEqual({ authMethod: 'unknown' })
  })

  it('coerces legacy azure-foundry into placeholder credentials when none present', () => {
    // Legacy rows pre-credentials field synthesize a minimal placeholder; UI
    // must surface "Re-add this account" elsewhere when resource is empty.
    const legacy = {
      id: 'a1',
      email: 'F',
      managedAuthPath: '/tmp',
      authMethod: 'azure-foundry' as const,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const migrated = migrateClaudeAccount(legacy as never)
    expect(migrated.credentials).toEqual({ authMethod: 'azure-foundry', resource: '', useEntraId: false })
  })
})
