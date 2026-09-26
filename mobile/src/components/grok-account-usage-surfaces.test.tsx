import type { ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))

import { GrokAccountUsageSection } from '../accounts/GrokAccountUsageSection'
import { decodeAccountsSnapshot } from './accounts-snapshot'
import { MobileHomeAccountUsageCards } from '../home/MobileHomeAccountUsageCards'
import type { HostProfile } from '../transport/types'

const now = 1_700_000_000_000
const hour = 60 * 60 * 1000

function windowOf(usedPercent: number, windowMinutes: number, resetsAt: number | null = null) {
  return { usedPercent, windowMinutes, resetsAt, resetDescription: null }
}

function snapshotWith(rateLimits: Record<string, unknown>) {
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

const host = {
  id: 'host-1',
  name: 'Mac',
  endpoint: 'ws://127.0.0.1',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 1
} satisfies HostProfile

function renderTree(element: ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(element)
  })
  return renderer
}

function renderedText(element: ReactElement): string {
  return JSON.stringify(renderTree(element).toJSON())
}

describe('Grok usage surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the Grok meter on the home card and hides it when the host is not signed in', () => {
    const signedIn = renderedText(
      <MobileHomeAccountUsageCards
        items={[
          {
            host,
            snapshot: snapshotWith({
              grokAuthConfigured: true,
              grok: {
                provider: 'grok',
                session: null,
                weekly: windowOf(12, 10_080, now + 3 * hour),
                updatedAt: 10,
                error: null,
                status: 'ok',
                usageMetadata: { authProvenance: 'dev@example.com (SuperGrok)' }
              }
            })
          }
        ]}
        onOpen={() => {}}
      />
    )
    expect(signedIn).toContain('dev@example.com (SuperGrok)')
    expect(signedIn).toContain('7d')
    expect(signedIn).toContain('12%')

    const signedOut = renderedText(
      <MobileHomeAccountUsageCards
        items={[
          {
            host,
            snapshot: snapshotWith({
              grok: {
                provider: 'grok',
                session: null,
                weekly: null,
                updatedAt: 10,
                error: 'Not signed in to Grok',
                status: 'unavailable'
              }
            })
          }
        ]}
        onOpen={() => {}}
      />
    )
    expect(signedOut).not.toContain('Not signed in to Grok')
    expect(signedOut).not.toContain('Signed in')
  })

  it('renders a read-only monthly Grok section on the accounts screen', () => {
    const text = renderedText(
      <GrokAccountUsageSection
        now={now}
        snapshot={snapshotWith({
          grok: {
            provider: 'grok',
            session: null,
            weekly: null,
            monthly: windowOf(25, 43_200, now + 6 * 24 * hour),
            updatedAt: 10,
            error: null,
            status: 'ok',
            usageMetadata: { authProvenance: 'dev@example.com (SuperGrok)' }
          }
        })}
      />
    )

    expect(text).toContain('Grok')
    expect(text).toContain('dev@example.com (SuperGrok)')
    expect(text).toContain('30d')
    expect(text).toContain('25%')
    expect(text).toContain('Resets in 6d')
  })

  it('renders nothing on the accounts screen when Grok has no session and no meter', () => {
    const renderer = renderTree(
      <GrokAccountUsageSection
        now={now}
        snapshot={snapshotWith({
          grok: {
            provider: 'grok',
            session: null,
            weekly: null,
            updatedAt: 10,
            error: 'Not signed in to Grok',
            status: 'unavailable'
          }
        })}
      />
    )
    expect(renderer.toJSON()).toBeNull()
  })
})
