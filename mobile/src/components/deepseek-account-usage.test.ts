import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { Text } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: Record<string, unknown>) => styles }
}))
vi.mock('lucide-react-native', () => ({ Wallet: 'Wallet' }))
vi.mock('./AgentIcons', () => ({ ClaudeIcon: 'ClaudeIcon', OpenAIIcon: 'OpenAIIcon' }))

import { decodeAccountsSnapshot, type AccountsSnapshot } from './accounts-snapshot'
import { getDeepSeekAccountUsage, hasDeepSeekAccountUsage } from './deepseek-account-usage'
import { DeepSeekAccountUsageSection } from '../accounts/DeepSeekAccountUsageSection'

function deepSeekLimits(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'deepseek',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: 10,
    error: null,
    status: 'ok',
    ...overrides
  }
}

function decode(rateLimits: Record<string, unknown>) {
  return decodeAccountsSnapshot({
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: null,
      codex: null,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [],
      ...rateLimits
    }
  })
}

describe('getDeepSeekAccountUsage', () => {
  it('shows the remaining balance from the host usage snapshot', () => {
    const snapshot = decode({
      deepseekAuthConfigured: true,
      deepseek: deepSeekLimits({
        monthly: {
          usedPercent: 0,
          windowMinutes: 43_200,
          resetsAt: null,
          resetDescription: 'USD 110.00'
        }
      })
    })

    expect(getDeepSeekAccountUsage(snapshot)).toEqual({
      balanceLabel: 'USD 110.00',
      status: 'available',
      statusLabel: 'Balance available'
    })
    expect(hasDeepSeekAccountUsage(snapshot)).toBe(true)
  })

  it('shows configured DeepSeek while the first balance request is pending', () => {
    const snapshot = decode({ deepseekAuthConfigured: true })

    expect(getDeepSeekAccountUsage(snapshot)).toEqual({
      balanceLabel: null,
      status: 'loading',
      statusLabel: 'Checking balance…'
    })
  })

  it('shows a depleted balance state', () => {
    const snapshot = decode({
      deepseek: deepSeekLimits({
        monthly: {
          usedPercent: 100,
          windowMinutes: 43_200,
          resetsAt: null,
          resetDescription: 'USD 0.00'
        }
      })
    })

    expect(getDeepSeekAccountUsage(snapshot)).toMatchObject({
      balanceLabel: 'USD 0.00',
      status: 'depleted',
      statusLabel: 'No balance remaining'
    })
  })

  it('keeps the last balance visible while reporting a refresh error', () => {
    const snapshot = decode({
      deepseekAuthConfigured: true,
      deepseek: deepSeekLimits({
        status: 'error',
        error: 'temporary network failure',
        monthly: {
          usedPercent: 0,
          windowMinutes: 43_200,
          resetsAt: null,
          resetDescription: 'USD 72.00'
        }
      })
    })

    expect(getDeepSeekAccountUsage(snapshot)).toMatchObject({
      balanceLabel: 'USD 72.00',
      status: 'refresh-error',
      statusLabel: 'Balance refresh failed'
    })
  })

  it('hides DeepSeek when the host has no configured key and no balance window', () => {
    const snapshot = decode({ deepseek: deepSeekLimits({ monthly: null }) })

    expect(getDeepSeekAccountUsage(snapshot)).toBeNull()
  })

  it('ignores a malformed DeepSeek slot without dropping Claude usage', () => {
    const snapshot = decode({
      claude: {
        ...deepSeekLimits(),
        provider: 'claude',
        session: {
          usedPercent: 25,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        }
      },
      deepseek: { provider: 'claude', status: 'ok' },
      deepseekAuthConfigured: true
    })

    expect(snapshot.rateLimits.claude?.status).toBe('ok')
    expect(getDeepSeekAccountUsage(snapshot)).toMatchObject({
      balanceLabel: null,
      status: 'unavailable',
      statusLabel: 'Balance unavailable'
    })
  })
})

describe('DeepSeek usage surfaces', () => {
  let mounted: ReactTestRenderer | null = null

  afterEach(async () => {
    await act(async () => mounted?.unmount())
    mounted = null
  })

  it.each([
    { name: 'pending', raw: undefined, text: 'Checking balance…', balance: null },
    { name: 'malformed', raw: { provider: 'claude' }, text: 'Balance unavailable', balance: null },
    {
      name: 'available',
      raw: deepSeekLimits({ monthly: balanceWindow(0, 'USD 72.00') }),
      text: null,
      balance: 'USD 72.00'
    },
    {
      name: 'depleted',
      raw: deepSeekLimits({ monthly: balanceWindow(100, 'USD 0.00') }),
      text: 'No balance remaining',
      balance: 'USD 0.00'
    },
    {
      name: 'refresh error',
      raw: deepSeekLimits({ status: 'error', monthly: balanceWindow(0, 'USD 72.00') }),
      text: 'Balance refresh failed',
      balance: 'USD 72.00'
    }
  ])('renders the $name balance on Accounts', async ({ raw, text, balance }) => {
    const snapshot = decode({ deepseekAuthConfigured: true, deepseek: raw })
    const tree = await renderSection(snapshot)
    const texts = tree.root.findAll((node) => node.type === Text)
    const shown = texts.map((node) => node.children.join(''))
    expect(shown.filter((value) => value === 'DeepSeek API')).toHaveLength(1)
    const primary = balance ?? text
    if (primary) {
      expect(shown).toContain(primary)
      expect(
        texts.find((node) => node.children.join('') === primary)?.props.accessibilityLiveRegion
      ).toBe('polite')
    }
    if (text && balance) {
      expect(shown).toContain(text)
      expect(
        texts.find((node) => node.children.join('') === text)?.props.accessibilityLiveRegion
      ).toBe('polite')
    }
  })

  async function renderSection(snapshot: AccountsSnapshot): Promise<ReactTestRenderer> {
    await act(async () => {
      mounted = create(createElement(DeepSeekAccountUsageSection, { snapshot }))
    })
    if (!mounted) {
      throw new Error('usage section did not mount')
    }
    return mounted
  }

  it('mounts the read-only DeepSeek section on Accounts', () => {
    const accounts = readFileSync(
      new URL('../accounts/MobileAccountsScreen.tsx', import.meta.url),
      'utf8'
    )
    const section = readFileSync(
      new URL('../accounts/DeepSeekAccountUsageSection.tsx', import.meta.url),
      'utf8'
    )

    expect(accounts).toContain('<DeepSeekAccountUsageSection snapshot={snapshot} />')
    expect(section).toContain('getDeepSeekAccountUsage(snapshot)')
  })
})

function balanceWindow(usedPercent: number, resetDescription: string) {
  return { usedPercent, windowMinutes: 43_200, resetsAt: null, resetDescription }
}
