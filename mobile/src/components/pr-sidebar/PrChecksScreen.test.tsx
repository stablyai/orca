import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../../src/shared/github/check-types'
import type { ScreenProps } from './pr-tab-screen-frame'

const observed = vi.hoisted((): { rows: { check: PRCheckDetail; initiallyOpen: boolean }[] } => ({
  rows: []
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: () => void) => effect()
}))
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  StyleSheet: { create: <T,>(styles: T) => styles }
}))
vi.mock('lucide-react-native', () => ({
  ChevronDown: 'i',
  CircleCheck: 'i',
  CircleMinus: 'i',
  LoaderCircle: 'i'
}))
vi.mock('../../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../../i18n/use-mobile-translation', async () => ({
  useMobileTranslation: () => (key: string, fallback: string) => fallback
}))
vi.mock('../../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText: vi.fn() }) }))
vi.mock('../../platform/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock('../../session/pr-ai-triage-prompt', () => ({ buildPrFixChecksPrompt: vi.fn() }))
vi.mock('../../session/use-mobile-launch-agent-label', () => ({
  useMobileLaunchAgentLabel: () => null
}))
vi.mock('../host-protocol-gates-context', () => ({
  useHostProtocolGates: () => ({ hostCapabilities: {} })
}))
vi.mock('../DisclosureChevron', () => ({ DisclosureChevron: () => null }))
vi.mock('../list/ListGroup', () => ({
  LIST_LEADING_INSET: 0,
  ListGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SectionHeader: () => null,
  ListRow: () => null
}))
vi.mock('./pr-tab-screen-frame', () => ({
  ScreenFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  NotReady: () => null
}))
vi.mock('./use-mobile-pr-tab', () => ({ readyPrData: (tab: { data: unknown }) => tab.data }))
vi.mock('./PrCheckFailureRow', () => ({
  PrCheckFailureRow: (props: (typeof observed.rows)[number]) => {
    observed.rows.push(props)
    return null
  }
}))

import { PrChecksScreen } from './PrChecksScreen'

describe('PrChecksScreen cancellation sections', () => {
  it.each([1, 3])(
    'shares one notice and three detail reads across %i failures plus cancellation',
    (failures) => {
      observed.rows = []
      const ensure = vi.fn()
      const checks: PRCheckDetail[] = Array.from({ length: failures + 1 }, (_, index) => ({
        name: `job-${index}`,
        status: 'completed',
        conclusion: index < failures ? 'failure' : 'cancelled',
        url: null
      }))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mocked dependencies consume only the screen fields supplied by this fixture.
      const tab = {
        data: { pr: { number: 7 }, checks },
        checkDetails: {},
        ensureCheckDetail: ensure,
        actions: { error: 'Retry failed', isBusy: () => false },
        triage: {
          availability: 'available',
          isBusy: () => false,
          noticeFor: () => ({ error: 'Agent launch failed' })
        }
      } as unknown as ScreenProps['tab']
      const markup = renderToStaticMarkup(createElement(PrChecksScreen, { tab, onBack: () => {} }))
      expect(markup.split('Retry failed')).toHaveLength(2)
      expect(markup.split('Agent launch failed')).toHaveLength(2)
      const opened = observed.rows.filter((row) => row.initiallyOpen).map((row) => row.check.name)
      expect(opened).toEqual(checks.slice(0, 3).map((check) => check.name))
      expect(ensure.mock.calls.map(([check]) => check.name)).toEqual(opened)
      expect(observed.rows.at(-1)?.initiallyOpen).toBe(failures < 3)
    }
  )
})
