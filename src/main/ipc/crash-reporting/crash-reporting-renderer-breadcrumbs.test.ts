import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB } from '../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'
import { getCrashBreadcrumbSnapshot } from '../../crash-reporting/breadcrumbs/crash-breadcrumb-store'
import { recordRendererBreadcrumbFromRenderer } from './crash-reporting-renderer-breadcrumbs'

describe('recordRendererBreadcrumbFromRenderer', () => {
  it('keeps different atlas-loss reasons and outcomes separate and coalesces a repeated pair', () => {
    const origin = 'terminal-atlas-test'
    const name = TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB
    const kind = 'webgl-atlas-poisoned'
    const first = { kind, reason: 'blank-page-glyph', outcome: 'reset', trigger: 'reveal' }
    const otherReason = { ...first, reason: 'empty-cached-glyph' }
    const otherOutcome = { ...first, outcome: 'refused' }

    vi.useFakeTimers({ toFake: ['Date', 'performance'] })
    try {
      for (const data of [first, otherReason, otherOutcome, first]) {
        recordRendererBreadcrumbFromRenderer({ name, data }, origin)
      }

      const stored = getCrashBreadcrumbSnapshot(origin).filter(
        (breadcrumb) => breadcrumb.name === name && breadcrumb.origin === origin
      )
      expect(stored.map((breadcrumb) => breadcrumb.data)).toEqual([
        { ...first, suppressedSinceLast: 1 },
        otherReason,
        otherOutcome
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
