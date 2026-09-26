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
