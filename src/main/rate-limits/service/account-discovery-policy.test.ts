import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { createAccountDiscoveryPolicy } from './account-discovery-policy'

function savedConnections() {
  return {
    opencodeGo: vi.fn(() => false),
    minimax: vi.fn(() => false),
    zcode: vi.fn(() => false),
    antigravity: vi.fn(() => false)
  }
}

describe('account discovery connections', () => {
  it('defaults missing settings to automatic discovery', () => {
    expect(
      createAccountDiscoveryPolicy(getDefaultSettings('/tmp'), savedConnections())
        .automaticallyDetect
    ).toBe(true)
  })

  it('requires a valid selected managed ID in the requested runtime, not merely a saved account', () => {
    const settings = getDefaultSettings('/tmp')
    settings.claudeManagedAccounts = [
      {
        id: 'claude-saved',
        email: 'account@example.test',
        managedAuthPath: '/saved',
        authMethod: 'subscription-oauth',
        createdAt: 0,
        updatedAt: 0,
        lastAuthenticatedAt: 0
      }
    ]
    settings.codexManagedAccounts = [
      {
        id: 'codex-saved',
        email: 'account@example.test',
        managedHomePath: '/saved',
        createdAt: 0,
        updatedAt: 0,
        lastAuthenticatedAt: 0
      }
    ]
    settings.activeClaudeManagedAccountIdsByRuntime = {
      host: null,
      wsl: { Ubuntu: 'claude-saved', Debian: 'removed' }
    }
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'codex-saved', wsl: { Ubuntu: null } }
    const policy = createAccountDiscoveryPolicy(settings, savedConnections())
    expect(policy.isConnected('claude', { runtime: 'host' })).toBe(false)
    expect(policy.isConnected('claude', { runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(true)
    expect(policy.isConnected('claude', { runtime: 'wsl', wslDistro: 'Debian' })).toBe(false)
    expect(policy.isConnected('codex', { runtime: 'host' })).toBe(true)
    expect(policy.isConnected('codex', { runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(false)
  })

  it('counts only saved Orca credentials and explicit OAuth, never ambient-only providers', () => {
    const settings = getDefaultSettings('/tmp')
    const saved = savedConnections()
    const policy = createAccountDiscoveryPolicy(settings, saved)
    for (const provider of [
      'grok',
      'cursor',
      'kimi',
      'gemini',
      'opencode-go',
      'minimax',
      'zcode',
      'antigravity'
    ] as const) {
      expect(policy.isConnected(provider)).toBe(false)
    }
    settings.geminiCliOAuthEnabled = true
    settings.opencodeSessionCookie = 'session=explicit'
    expect(policy.isConnected('gemini')).toBe(true)
    expect(policy.isConnected('opencode-go')).toBe(true)
    settings.opencodeSessionCookie = ''
    saved.opencodeGo.mockReturnValue(true)
    saved.minimax.mockReturnValue(true)
    saved.zcode.mockReturnValue(true)
    saved.antigravity.mockReturnValue(true)
    for (const provider of ['opencode-go', 'minimax', 'zcode', 'antigravity'] as const) {
      expect(policy.isConnected(provider)).toBe(true)
    }
  })
})
