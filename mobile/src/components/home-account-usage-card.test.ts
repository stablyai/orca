import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeAccountUsageCard } from './HomeAccountUsageCard'
import type { AccountsSnapshot, ProviderRateLimits } from './account-usage-state'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({ Gauge: 'Gauge' }))
vi.mock('./AgentIcons', () => ({ ClaudeIcon: 'ClaudeIcon', OpenAIIcon: 'OpenAIIcon' }))

function limits(provider: ProviderRateLimits['provider']): ProviderRateLimits {
  return {
    provider,
    session: {
      usedPercent: 25,
      windowMinutes: 300,
      resetsAt: 3_600_000,
      resetDescription: null
    },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

function snapshot(): AccountsSnapshot {
  return {
    claude: {
      accounts: [{ id: 'claude-1', email: 'claude@example.com' }],
      activeAccountId: 'claude-1'
    },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: limits('claude'),
      codex: null,
      antigravity: limits('antigravity'),
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
}

function textValues(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text')
    .map((node) => node.props.children)
    .filter((value): value is string => typeof value === 'string')
}

describe('HomeAccountUsageCard visibility', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const originalConsoleError = console.error
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      originalConsoleError(...args)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders only providers selected by the persisted visibility set', () => {
    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(
        createElement(HomeAccountUsageCard, {
          snapshot: snapshot(),
          visibleProviders: new Set(['antigravity']),
          showHostName: false,
          hostName: 'Desk',
          now: 0,
          onPress: vi.fn()
        })
      )
    })

    const texts = textValues(renderer!)
    expect(texts).toContain('Antigravity')
    expect(texts).not.toContain('claude@example.com')

    act(() => renderer?.unmount())
  })

  it('renders display-only provider reset countdowns using the current timestamp', () => {
    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(
        createElement(HomeAccountUsageCard, {
          snapshot: snapshot(),
          visibleProviders: new Set(['antigravity']),
          showHostName: false,
          hostName: 'Desk',
          now: 0,
          onPress: vi.fn()
        })
      )
    })

    expect(textValues(renderer!)).toContain('Resets in 1h')

    act(() => renderer?.unmount())
  })
})
