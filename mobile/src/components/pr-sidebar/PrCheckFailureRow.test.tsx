import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckRunDetails } from '../../../../src/shared/github/check-types'
import { activateMobileUiLocale, translate } from '../../i18n/mobile-i18n'
import { colors } from '../../theme/mobile-theme'
import { PrCheckFailureRow } from './PrCheckFailureRow'

vi.mock('react-native', () => {
  const Primitive = ({
    children,
    style
  }: {
    children?: ReactNode
    style?: object | (object | false)[]
  }) => {
    const flat = Object.assign({}, ...[style].flat())
    return (
      <div data-color={flat.color} data-border-color={flat.borderLeftColor}>
        {children}
      </div>
    )
  }
  return {
    ActivityIndicator: () => null,
    Pressable: Primitive,
    Text: Primitive,
    View: Primitive,
    StyleSheet: { create: <T,>(styles: T) => styles }
  }
})
vi.mock('lucide-react-native', () => ({
  CircleX: ({ color }: { color: string }) => <i data-check-color={color} />,
  Copy: 'i',
  ExternalLink: 'i',
  MoreHorizontal: 'i',
  RotateCw: 'i',
  Sparkles: 'i',
  SquareTerminal: 'i'
}))
vi.mock('../../i18n/use-mobile-translation', () => ({ useMobileTranslation: () => translate }))
vi.mock('../../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText: vi.fn() }) }))
vi.mock('../../platform/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock('../../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))
vi.mock('../list/ListGroup', () => ({ LIST_LEADING_SLOT: 20, LIST_ROW_PADDING: 16 }))
vi.mock('../nav-bar/PullDownMenu', () => ({ PullDownMenu: () => null }))
vi.mock('./PrMiniButton', () => ({ PrMiniButton: () => null }))
vi.mock('./PRCheckDetail', () => ({ PRCheckDetailView: () => null }))

describe('expanded check diagnostic tone', () => {
  afterEach(async () => {
    await activateMobileUiLocale('en')
  })

  it.each([
    { conclusion: 'cancelled', diagnostic: 'title', locale: 'en' },
    { conclusion: 'cancelled', diagnostic: 'title', locale: 'de' },
    { conclusion: 'cancelled', diagnostic: 'notice', locale: 'en' },
    { conclusion: 'cancelled', diagnostic: 'failureAnnotation', locale: 'en' },
    { conclusion: 'cancelled', diagnostic: 'cancelledStep', locale: 'en' },
    { conclusion: 'cancelled', diagnostic: 'failureStep', locale: 'en' },
    { conclusion: 'failure', diagnostic: 'title', locale: 'en' },
    { conclusion: 'failure', diagnostic: 'failureAnnotation', locale: 'en' }
  ] as const)(
    '$conclusion with $diagnostic in $locale preserves the diagnostic meaning',
    async ({ conclusion, diagnostic, locale }) => {
      await activateMobileUiLocale(locale)
      const hasAnnotation = diagnostic === 'notice' || diagnostic === 'failureAnnotation'
      const hasStep = diagnostic === 'cancelledStep' || diagnostic === 'failureStep'
      const details: PRCheckRunDetails = {
        name: 'Build',
        status: 'completed',
        conclusion,
        url: null,
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
        title: 'Workflow ended',
        summary: null,
        text: null,
        annotations: hasAnnotation
          ? [
              {
                path: 'build.ts',
                startLine: 3,
                endLine: 3,
                annotationLevel: diagnostic === 'failureAnnotation' ? 'failure' : 'notice',
                title: 'Build diagnostic',
                message: 'Diagnostic content',
                rawDetails: null
              }
            ]
          : [],
        jobs: hasStep
          ? [
              {
                id: 1,
                name: 'Build',
                status: 'completed',
                conclusion,
                startedAt: null,
                completedAt: null,
                url: null,
                logTail: null,
                steps: [
                  {
                    name: 'Build step',
                    status: 'completed',
                    conclusion: diagnostic === 'failureStep' ? 'failure' : 'cancelled',
                    startedAt: null,
                    completedAt: null
                  }
                ]
              }
            ]
          : []
      }
      const markup = renderToStaticMarkup(
        createElement(PrCheckFailureRow, {
          check: { name: details.name, status: 'completed', conclusion, url: null },
          entry: { status: 'loaded', details },
          initiallyOpen: true,
          onOpen: vi.fn(),
          actionable: false,
          fixLabel: 'Fix',
          onFix: vi.fn(),
          fixBusy: false,
          fixAvailable: true,
          onRerun: vi.fn(),
          rerunBusy: false
        })
      )
      const tone = conclusion === 'cancelled' ? colors.textSecondary : colors.statusRed
      expect(markup).toContain(`data-border-color="${tone}"`)
      expect(markup).toContain(`data-check-color="${tone}"`)
      expect(markup).toContain(conclusion === 'cancelled' ? 'Cancelled' : 'Failed')
      const displayed = hasAnnotation
        ? 'Diagnostic content'
        : hasStep
          ? 'Build step'
          : 'Workflow ended'
      expect(markup).toContain(displayed)
      if (hasAnnotation || hasStep) {
        const realFailure = diagnostic === 'failureAnnotation' || diagnostic === 'failureStep'
        const diagnosticColor = realFailure
          ? colors.statusRed
          : hasAnnotation
            ? colors.textMuted
            : colors.textPrimary
        expect(markup).toContain(`data-color="${diagnosticColor}">${displayed}</div>`)
      }
      if (hasAnnotation) {
        expect(markup).toContain('build.ts:3')
      }
    }
  )
})
