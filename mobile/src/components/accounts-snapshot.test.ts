import { describe, expect, it } from 'vitest'

import { decodeAccountsSnapshot } from './accounts-snapshot'

function makeSnapshot(): unknown {
  return {
    extensionField: { retained: true },
    claude: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    codex: {
      accounts: [
        {
          id: 'codex-host',
          email: 'host@example.com',
          managedHomeRuntime: 'host',
          wslDistro: null,
          updatedAt: 100,
          extensionField: 'account-extra'
        }
      ],
      activeAccountId: 'codex-host',
      activeAccountIdsByRuntime: {
        host: 'codex-host',
        wsl: { Ubuntu: 'codex-wsl' }
      }
    },
    rateLimits: {
      extensionField: 'limits-extra',
      claude: null,
      codex: {
        provider: 'codex',
        session: {
          usedPercent: 100,
          windowMinutes: 300,
          resetsAt: 200,
          resetDescription: 'soon'
        },
        weekly: null,
        rateLimitResetCredits: {
          availableCount: 1,
          totalEarnedCount: 2,
          nextExpiresAt: 300,
          credits: [{ status: 'available', expiresAt: 300, grantedAt: 50 }]
        },
        updatedAt: 100,
        error: null,
        status: 'ok',
        extensionField: 'provider-extra'
      },
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [
        {
          accountId: 'codex-inactive',
          rateLimits: null,
          updatedAt: 99,
          isFetching: false
        }
      ]
    }
  }
}

function setPath(root: unknown, path: string[], value: unknown): void {
  let current: unknown = root
  for (const segment of path.slice(0, -1)) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`Invalid fixture path: ${path.join('.')}`)
    }
    current = (current as Record<string, unknown>)[segment]
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error(`Invalid fixture path: ${path.join('.')}`)
  }
  const record = current as Record<string, unknown>
  record[path.at(-1)!] = value
}

describe('decodeAccountsSnapshot', () => {
  it('validates nested account/rate-limit state and preserves forward-compatible fields', () => {
    const snapshot = decodeAccountsSnapshot(makeSnapshot())

    expect(snapshot.extensionField).toEqual({ retained: true })
    expect(snapshot.codex.accounts[0]?.extensionField).toBe('account-extra')
    expect(snapshot.rateLimits.extensionField).toBe('limits-extra')
    expect(snapshot.rateLimits.codex?.extensionField).toBe('provider-extra')
  })

  it('defaults missing runtime targets for older host-only snapshots', () => {
    const raw = makeSnapshot() as {
      rateLimits: { claudeTarget?: unknown; codexTarget?: unknown }
    }
    delete raw.rateLimits.claudeTarget
    delete raw.rateLimits.codexTarget

    const snapshot = decodeAccountsSnapshot(raw)

    expect(snapshot.rateLimits.claudeTarget).toEqual({ runtime: 'host', wslDistro: null })
    expect(snapshot.rateLimits.codexTarget).toEqual({ runtime: 'host', wslDistro: null })
  })

  it.each([
    ['account arrays', ['codex', 'accounts'], {}],
    ['active account IDs', ['codex', 'activeAccountId'], 42],
    ['runtime selections', ['codex', 'activeAccountIdsByRuntime', 'wsl'], []],
    ['targets', ['rateLimits', 'codexTarget', 'runtime'], 'remote'],
    ['provider identity', ['rateLimits', 'codex', 'provider'], 'claude'],
    ['inactive account arrays', ['rateLimits', 'inactiveCodexAccounts'], {}],
    ['window percentages', ['rateLimits', 'codex', 'session', 'usedPercent'], 101],
    ['credit counts', ['rateLimits', 'codex', 'rateLimitResetCredits', 'availableCount'], -1],
    [
      'credit status',
      ['rateLimits', 'codex', 'rateLimitResetCredits', 'credits'],
      [{ status: '', expiresAt: 300, grantedAt: 50 }]
    ],
    ['credit expiry', ['rateLimits', 'codex', 'rateLimitResetCredits', 'nextExpiresAt'], 'soon']
  ] satisfies Array<[string, string[], unknown]>)('rejects malformed %s', (_name, path, value) => {
    const snapshot = makeSnapshot()
    setPath(snapshot, path, value)

    expect(() => decodeAccountsSnapshot(snapshot)).toThrow('Invalid accounts snapshot from host')
  })

  it('keeps Grok weekly usage from hosts that report it', () => {
    const raw = makeSnapshot() as { rateLimits: Record<string, unknown> }
    raw.rateLimits.grok = {
      provider: 'grok',
      session: null,
      weekly: {
        usedPercent: 42,
        windowMinutes: 10080,
        resetsAt: 400,
        resetDescription: 'Thu'
      },
      updatedAt: 100,
      error: null,
      status: 'ok',
      usageMetadata: { authProvenance: 'Grok CLI session' }
    }
    raw.rateLimits.grokAuthConfigured = true

    const snapshot = decodeAccountsSnapshot(raw)

    expect(snapshot.rateLimits.grok).toMatchObject({
      weekly: { usedPercent: 42 },
      usageMetadata: { authProvenance: 'Grok CLI session' }
    })
    expect(snapshot.rateLimits.grokAuthConfigured).toBe(true)
  })

  it('keeps desktop provider usage and managed profiles when the host reports them', () => {
    const raw = makeSnapshot() as {
      opencode?: unknown
      rateLimits: Record<string, unknown>
    }
    raw.opencode = {
      accounts: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          label: 'Work',
          integrations: ['github'],
          createdAt: 10
        }
      ],
      activeAccountId: null
    }
    raw.rateLimits.opencodeGo = {
      provider: 'opencode-go',
      session: null,
      weekly: null,
      monthly: { usedPercent: 33, windowMinutes: 43200, resetsAt: null, resetDescription: null },
      updatedAt: 100,
      error: null,
      status: 'ok'
    }
    raw.rateLimits.zcode = {
      provider: 'zcode',
      session: { usedPercent: 10, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      updatedAt: 100,
      error: null,
      status: 'ok'
    }
    raw.rateLimits.cursorAuthConfigured = true
    raw.rateLimits.minimaxApiKeyConfigured = true

    const snapshot = decodeAccountsSnapshot(raw)

    expect(snapshot.opencode?.accounts[0]).toMatchObject({ label: 'Work' })
    expect(snapshot.rateLimits.opencodeGo).toMatchObject({ monthly: { usedPercent: 33 } })
    expect(snapshot.rateLimits.zcode).toMatchObject({
      provider: 'zcode',
      session: { usedPercent: 10 }
    })
    expect(snapshot.rateLimits.cursorAuthConfigured).toBe(true)
    expect(snapshot.rateLimits.minimaxApiKeyConfigured).toBe(true)
    expect(snapshot.devin).toBeUndefined()
  })

  it('rejects Grok limits that claim another provider', () => {
    const snapshot = makeSnapshot()
    setPath(snapshot, ['rateLimits', 'grok'], {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: 100,
      error: null,
      status: 'ok'
    })

    expect(() => decodeAccountsSnapshot(snapshot)).toThrow('Invalid accounts snapshot from host')
  })

  it('rejects Zcode limits that claim another provider', () => {
    const snapshot = makeSnapshot()
    setPath(snapshot, ['rateLimits', 'zcode'], {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: 100,
      error: null,
      status: 'ok'
    })

    expect(() => decodeAccountsSnapshot(snapshot)).toThrow('Invalid accounts snapshot from host')
  })

  it('rejects a host target that smuggles a WSL distro', () => {
    const snapshot = makeSnapshot()
    setPath(snapshot, ['rateLimits', 'codexTarget', 'wslDistro'], 'Ubuntu')

    expect(() => decodeAccountsSnapshot(snapshot)).toThrow('Invalid accounts snapshot from host')
  })
})
