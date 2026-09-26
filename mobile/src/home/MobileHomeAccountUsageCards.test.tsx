import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountsSnapshot, ProviderRateLimits } from '../components/AccountUsage'
import { MobileHomeAccountUsageCards } from './MobileHomeAccountUsageCards'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('../components/AgentIcons', () => ({
  ClaudeIcon: 'ClaudeIcon',
  OpenAIIcon: 'OpenAIIcon'
}))

const host = {
  id: 'host-1',
  name: 'Desk',
  endpoint: 'ws://desk.local:6768',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 0
}

/** Builds Claude rate limits for usage-card tests. */
function makeClaudeLimits(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent: 12, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: { usedPercent: 28, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
    updatedAt: 0,
    error: null,
    status: 'ok',
    ...overrides
  }
}

/** Builds an accounts snapshot with the provided Claude limits. */
function makeSnapshot(claudeLimits: ProviderRateLimits): AccountsSnapshot {
  return {
    claude: {
      accounts: [{ id: 'claude-a', email: 'claude@example.com' }],
      activeAccountId: 'claude-a',
      activeAccountIdsByRuntime: { host: 'claude-a', wsl: {} }
    },
    codex: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    rateLimits: {
      claude: claudeLimits,
      codex: null,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
}

describe('MobileHomeAccountUsageCards', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  /** Renders the usage cards and returns their text content. */
  async function renderWith(snapshot: AccountsSnapshot): Promise<string[]> {
    await act(async () => {
      renderer = create(
        createElement(MobileHomeAccountUsageCards, {
          items: [{ host, snapshot }],
          onOpen: () => {}
        })
      )
    })
    return renderer!.root
      .findAllByType('Text')
      .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
  }

  it('renders a Claude F weekly usage bar when the snapshot includes fableWeekly', async () => {
    const text = await renderWith(
      makeSnapshot(
        makeClaudeLimits({
          fableWeekly: {
            usedPercent: 42,
            windowMinutes: 10_080,
            resetsAt: null,
            resetDescription: null
          }
        })
      )
    )

    expect(text).toContain('5h')
    expect(text).toContain('7d')
    expect(text).toContain('F')
  })

  it('does not render an F label when fableWeekly is absent', async () => {
    const text = await renderWith(makeSnapshot(makeClaudeLimits({ fableWeekly: null })))
    expect(text).not.toContain('F')
  })
})
