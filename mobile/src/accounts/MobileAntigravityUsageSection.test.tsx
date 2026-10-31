import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { decodeAccountsSnapshot, type ProviderRateLimits } from '../components/accounts-snapshot'
import { MobileAntigravityUsageSection } from './MobileAntigravityUsageSection'

vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (key: string, fallback: string) => {
    if (key === 'accounts.screen.antigravity') {
      return 'Localized Antigravity'
    }
    if (key === 'accounts.screen.sessionWindow') {
      return 'Localized 5h'
    }
    if (key === 'accounts.screen.weeklyWindow') {
      return 'Localized 7d'
    }
    return fallback
  }
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))

const NOW = 1_000_000

const bucket = {
  name: 'Claude and GPT models',
  usedPercent: 30,
  windowMinutes: 10080,
  resetsAt: NOW + 2 * 3_600_000,
  resetDescription: null
}

const baseLimits = {
  provider: 'antigravity',
  session: null,
  weekly: bucket,
  buckets: [bucket],
  updatedAt: 1,
  error: null,
  status: 'ok'
}

function decodeAntigravityLimits(antigravity?: unknown): ProviderRateLimits | null {
  const snapshot = decodeAccountsSnapshot({
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: null,
      codex: null,
      antigravity,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  })
  return snapshot.rateLimits.antigravity ?? null
}

async function renderSection(antigravity?: unknown): Promise<string> {
  const limits = decodeAntigravityLimits(antigravity)
  let tree: ReturnType<typeof create>
  await act(async () => {
    tree = create(createElement(MobileAntigravityUsageSection, { limits, now: NOW }))
  })
  const output = JSON.stringify(tree!.toJSON())
  await act(async () => tree!.unmount())
  return output
}

describe('MobileAntigravityUsageSection', () => {
  it('renders named quota buckets as consumption with reset countdown without duplicating weekly summary', async () => {
    const output = await renderSection(baseLimits)
    expect(output).toContain('Localized Antigravity')
    expect(output).toContain('Localized 7d')
    expect(output).toContain('Claude and GPT models')
    expect(output).toContain('Resets in 2h')
    expect(output.match(/30%/g)).toHaveLength(2)
    expect(output).not.toContain('70%')
  })

  it('accepts older hosts and hides absent or empty unavailable usage', async () => {
    expect(await renderSection()).toBe('null')
    expect(
      await renderSection({
        provider: 'antigravity',
        session: null,
        weekly: null,
        updatedAt: 1,
        error: null,
        status: 'unavailable'
      })
    ).toBe('null')
  })

  it('retains unknown-duration buckets without claiming a 5h or weekly window', async () => {
    const output = await renderSection({
      ...baseLimits,
      weekly: null,
      buckets: [{ ...bucket, windowMinutes: 0, resetsAt: null }]
    })
    expect(output).toContain('30%')
    expect(output).not.toContain('Localized 7d')
    expect(output).not.toContain('Localized 5h')
  })

  it('falls back to session and weekly summary windows when a host omits buckets', async () => {
    const output = await renderSection({ ...baseLimits, buckets: undefined })
    expect(output).toContain('System default')
    expect(output).toContain('30%')
    expect(output).toContain('Localized 5h')
    expect(output).toContain('Localized 7d')
    expect(output).toContain('Resets in 2h')
  })

  it('assigns distinct React keys when buckets collide on id or share name and windowMinutes', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const output = await renderSection({
        ...baseLimits,
        buckets: [
          { ...bucket, id: 'pool', usedPercent: 25 },
          { ...bucket, id: 'pool', usedPercent: 50 },
          { ...bucket, id: 'pool-1', usedPercent: 75 },
          { ...bucket, usedPercent: 10 },
          { ...bucket, usedPercent: 90 }
        ]
      })
      expect(output).toContain('25%')
      expect(output).toContain('50%')
      expect(output).toContain('75%')
      expect(output).toContain('10%')
      expect(output).toContain('90%')
      const duplicateKeyLogged = errorSpy.mock.calls.some((args) =>
        args.some((arg) => String(arg).includes('same key'))
      )
      expect(duplicateKeyLogged).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
