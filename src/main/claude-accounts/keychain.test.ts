import { afterEach, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => vi.fn(async () => null))
vi.mock('../macos-keychain/generic-password', () => ({ readKeychainPassword: reads }))

import { readActiveClaudeKeychainCredentialsStrict } from './keychain'

const originalUser = process.env.USER
afterEach(() => {
  process.env.USER = originalUser
  reads.mockClear()
})

it('reads the claude-code-user item when $USER is not a valid Keychain account (#12857)', async () => {
  process.env.USER = 'first@example.com'
  await readActiveClaudeKeychainCredentialsStrict()
  expect(reads).toHaveBeenCalledWith('Claude Code-credentials', 'claude-code-user')
  process.env.USER = 'first.last'
  await readActiveClaudeKeychainCredentialsStrict()
  expect(reads).toHaveBeenLastCalledWith('Claude Code-credentials', 'first.last')
})
