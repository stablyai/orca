import { expect, it } from 'vitest'
import { findDuplicateClaudeAccount } from './claude-duplicate-account'

it('rejects registration of the same WSL identity through a distro casing alias', () => {
  const saved = {
    id: 'existing',
    email: 'person@example.com',
    organizationUuid: 'org',
    managedAuthRuntime: 'wsl' as const,
    wslDistro: 'Ubuntu',
    authMethod: 'subscription-oauth' as const,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
  expect(
    findDuplicateClaudeAccount([saved], {
      email: 'PERSON@example.com',
      organizationUuid: 'org',
      managedAuthRuntime: 'wsl',
      wslDistro: 'ubuntu'
    })?.id
  ).toBe('existing')
  expect(
    findDuplicateClaudeAccount([saved], {
      email: 'person@example.com',
      organizationUuid: 'other',
      managedAuthRuntime: 'wsl',
      wslDistro: 'ubuntu'
    })
  ).toBeNull()
})
