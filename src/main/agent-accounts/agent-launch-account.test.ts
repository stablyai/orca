import { describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount, CodexManagedAccount } from '../../shared/managed-account-types'
import { resolveAgentLaunchAccount } from './agent-launch-account'
import type { KeptConversation } from './kept-agent-conversations'

function claudeAccount(id: string): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath: '/unused',
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

function codexAccount(id: string): CodexManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath: '/unused',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

const SETTINGS = {
  claudeManagedAccounts: [claudeAccount('claude-a')],
  codexManagedAccounts: [codexAccount('codex-a')]
}

function keptIndex(entries: Record<string, KeptConversation> | 'unavailable'): {
  filePath: string
  get: (provider: string, sessionId: string) => KeptConversation | null | 'unavailable'
} {
  return {
    filePath: '/data/agent-kept-conversations.json',
    get: (provider, sessionId) =>
      entries === 'unavailable' ? 'unavailable' : (entries[`${provider}:${sessionId}`] ?? null)
  }
}

function resolve(overrides: Partial<Parameters<typeof resolveAgentLaunchAccount>[0]> = {}) {
  return resolveAgentLaunchAccount({
    connectionId: null,
    launchAgent: 'claude',
    resumeProviderSession: { key: 'session_id', id: 's1' },
    lane: 'host',
    kept: keptIndex({ 'claude:s1': { lane: 'host', accountId: 'claude-a', keptAt: 1 } }),
    settings: SETTINGS,
    ...overrides
  })
}

describe('resolveAgentLaunchAccount', () => {
  it('binds a kept conversation to its account', () => {
    expect(resolve()).toEqual({
      kind: 'bound',
      provider: 'claude',
      accountId: 'claude-a',
      mode: 'kept'
    })
    expect(
      resolve({
        launchAgent: 'codex',
        kept: keptIndex({ 'codex:s1': { lane: 'host', accountId: null, keptAt: 1 } })
      })
    ).toEqual({ kind: 'bound', provider: 'codex', accountId: null, mode: 'kept' })
  })

  it.each([
    ['a conversation nobody kept', { kept: keptIndex({}) }],
    ['a relay pane', { connectionId: 'ssh-1' }],
    ['another agent', { launchAgent: 'gemini' as const }],
    ['a fresh start', { resumeProviderSession: undefined }],
    ['a host with no index', { kept: undefined }],
    [
      'the same session kept for another agent',
      {
        launchAgent: 'codex' as const,
        kept: keptIndex({ 'claude:s1': { lane: 'host', accountId: null, keptAt: 1 } })
      }
    ]
  ])('follows the selection for %s', (_label, overrides) => {
    expect(resolve(overrides)).toEqual({ kind: 'follow' })
  })

  it('refuses while the index cannot be read, instead of following the selection', () => {
    const result = resolve({ kept: keptIndex('unavailable') })
    expect(result.kind).toBe('refuse')
    expect(result.kind === 'refuse' && result.error.message).toMatch(/could not read/)
    // Says which file, and the way out when it never becomes readable.
    expect(result.kind === 'refuse' && result.error.message).toContain(
      '/data/agent-kept-conversations.json'
    )
  })

  it('refuses a conversation kept on another lane', () => {
    const result = resolve({ lane: 'wsl:Ubuntu' })
    expect(result.kind === 'refuse' && result.error.message).toMatch(/another environment/)
  })

  it('refuses a conversation kept on an account that is no longer saved', () => {
    const result = resolve({ settings: { ...SETTINGS, claudeManagedAccounts: [] } })
    expect(result.kind === 'refuse' && result.error.message).toMatch(/no longer saved/)
  })
})
