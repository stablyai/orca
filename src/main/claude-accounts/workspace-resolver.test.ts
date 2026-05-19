import { describe, expect, it } from 'vitest'
import { resolveActiveClaudeAccountId } from './workspace-resolver'
import type { GlobalSettings } from '../../shared/types'

function makeSettings(partial: Partial<GlobalSettings>): GlobalSettings {
  return {
    activeClaudeManagedAccountId: null,
    claudeAccountIdByWorkspace: {},
    claudeManagedAccounts: [],
    ...partial
  } as GlobalSettings
}

describe('resolveActiveClaudeAccountId', () => {
  it('returns the per-workspace override when set', () => {
    const settings = makeSettings({
      activeClaudeManagedAccountId: 'global-A',
      claudeAccountIdByWorkspace: { 'r::/wt1': 'ws-B' },
      claudeManagedAccounts: [
        {
          id: 'global-A',
          email: 'g',
          managedAuthPath: '',
          authMethod: 'subscription-oauth',
          credentials: { authMethod: 'subscription-oauth' },
          modelMapping: {},
          fallbackAccountIds: [],
          createdAt: 0,
          updatedAt: 0,
          lastAuthenticatedAt: 0
        },
        {
          id: 'ws-B',
          email: 'b',
          managedAuthPath: '',
          authMethod: 'anthropic-api-key',
          credentials: { authMethod: 'anthropic-api-key' },
          modelMapping: {},
          fallbackAccountIds: [],
          createdAt: 0,
          updatedAt: 0,
          lastAuthenticatedAt: 0
        }
      ]
    })
    expect(resolveActiveClaudeAccountId(settings, 'r::/wt1')).toBe('ws-B')
  })

  it('falls back to the global active id when no override', () => {
    const settings = makeSettings({
      activeClaudeManagedAccountId: 'global-A',
      claudeAccountIdByWorkspace: { 'r::/other': 'ws-B' }
    })
    expect(resolveActiveClaudeAccountId(settings, 'r::/wt1')).toBe('global-A')
  })

  it('returns null when neither override nor global is set', () => {
    const settings = makeSettings({})
    expect(resolveActiveClaudeAccountId(settings, 'r::/wt1')).toBeNull()
  })

  it('returns the global default when worktreeId is undefined', () => {
    const settings = makeSettings({
      activeClaudeManagedAccountId: 'global-A',
      claudeAccountIdByWorkspace: { 'r::/wt1': 'ws-B' }
    })
    expect(resolveActiveClaudeAccountId(settings, undefined)).toBe('global-A')
  })

  it('ignores stale worktree overrides that point to a removed account', () => {
    const settings = makeSettings({
      activeClaudeManagedAccountId: 'global-A',
      claudeAccountIdByWorkspace: { 'r::/wt1': 'ws-DELETED' },
      claudeManagedAccounts: [
        {
          id: 'global-A',
          email: 'g',
          managedAuthPath: '',
          authMethod: 'subscription-oauth',
          credentials: { authMethod: 'subscription-oauth' },
          modelMapping: {},
          fallbackAccountIds: [],
          createdAt: 0,
          updatedAt: 0,
          lastAuthenticatedAt: 0
        }
      ]
    })
    expect(resolveActiveClaudeAccountId(settings, 'r::/wt1')).toBe('global-A')
  })
})
