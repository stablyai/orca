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
import { MobileHomeAccountUsageCards } from '../home/MobileHomeAccountUsageCards'

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
  ])('renders the $name balance on Home and Accounts', async ({ raw, text, balance }) => {
    const snapshot = decode({ deepseekAuthConfigured: true, deepseek: raw })
    const tree = await renderSurfaces(snapshot)
    const texts = tree.root.findAll((node) => node.type === Text)
    const shown = texts.map((node) => node.children.join(''))
    expect(shown.filter((value) => value === 'DeepSeek API')).toHaveLength(2)
    if (balance) {
      expect(shown).toContain(`Balance ${balance}`)
      expect(shown).toContain(balance)
    }
    if (text) {
      expect(shown.filter((value) => value === text)).toHaveLength(2)
      expect(
        texts
          .filter((node) => node.children.join('') === text)
          .map((node) => node.props.accessibilityLiveRegion)
      ).toEqual(['polite', 'polite'])
    }
  })

  async function renderSurfaces(snapshot: AccountsSnapshot): Promise<ReactTestRenderer> {
    await act(async () => {
      mounted = create(
        createElement(
          'root',
          null,
          createElement(MobileHomeAccountUsageCards, {
            items: [
              {
                host: {
                  id: 'host',
                  name: 'Host',
                  endpoint: 'ws://host',
                  deviceToken: 'token',
                  publicKeyB64: 'key',
                  lastConnected: 1
                },
                snapshot
              }
            ],
            onOpen: () => {}
          }),
          createElement(DeepSeekAccountUsageSection, { snapshot })
        )
      )
    })
    if (!mounted) {
      throw new Error('usage surfaces did not mount')
    }
    return mounted
  }

  it('keeps DeepSeek-only host inclusion and Accounts route wiring', () => {
    const homeData = readFileSync(
      new URL('../home/use-mobile-home-data.ts', import.meta.url),
      'utf8'
    )
    const accounts = readFileSync(
      new URL('../../app/h/[hostId]/accounts.tsx', import.meta.url),
      'utf8'
    )

    expect(homeData).toContain('hasDeepSeekAccountUsage(snapshot)')
    expect(accounts).toContain('<DeepSeekAccountUsageSection snapshot={snapshot} />')
  })
})

function balanceWindow(usedPercent: number, resetDescription: string) {
  return { usedPercent, windowMinutes: 43_200, resetsAt: null, resetDescription }
}
