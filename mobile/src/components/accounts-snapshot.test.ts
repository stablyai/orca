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

  it('rejects a host target that smuggles a WSL distro', () => {
    const snapshot = makeSnapshot()
    setPath(snapshot, ['rateLimits', 'codexTarget', 'wslDistro'], 'Ubuntu')

    expect(() => decodeAccountsSnapshot(snapshot)).toThrow('Invalid accounts snapshot from host')
  })
})

describe('kiro provider (additive, Remote Wire Compatible)', () => {
  it('decodes a snapshot carrying a kiro monthly provider', () => {
    const base = makeSnapshot() as {
      rateLimits: Record<string, unknown>
    }
    base.rateLimits.kiro = {
      provider: 'kiro',
      session: null,
      weekly: null,
      monthly: {
        usedPercent: 16,
        windowMinutes: 43200,
        resetsAt: 1000,
        resetDescription: '2026-10-01'
      },
      planType: 'KIRO PRO',
      kiroCredits: { used: 158.11, limit: 1000 },
      updatedAt: 10,
      error: null,
      status: 'ok'
    }
    const decoded = decodeAccountsSnapshot(base)
    expect(decoded.rateLimits.kiro?.provider).toBe('kiro')
    expect(decoded.rateLimits.kiro?.monthly?.usedPercent).toBe(16)
    expect(decoded.rateLimits.kiro?.planType).toBe('KIRO PRO')
  })

  it('accepts snapshots from older hosts that omit kiro', () => {
    const decoded = decodeAccountsSnapshot(makeSnapshot())
    expect(decoded.rateLimits.kiro ?? null).toBeNull()
  })

  it('rejects a kiro block carrying the wrong provider identity', () => {
    const base = makeSnapshot() as { rateLimits: Record<string, unknown> }
    base.rateLimits.kiro = {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: 1,
      error: null,
      status: 'ok'
    }
    expect(() => decodeAccountsSnapshot(base)).toThrow()
  })
})
