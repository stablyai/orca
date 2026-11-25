import { describe, expect, it } from 'vitest'
import { TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB } from '../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'
import { rendererBreadcrumbCoalesceKey } from './crash-reporting-renderer-breadcrumbs'

describe('rendererBreadcrumbCoalesceKey', () => {
  it('keeps poisoned-atlas observations with different reasons or outcomes apart', () => {
    const key = (reason: string, outcome: string) =>
      rendererBreadcrumbCoalesceKey(TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB, {
        kind: 'webgl-atlas-poisoned',
        reason,
        outcome,
        trigger: 'reveal'
      })
    const keys = new Set([
      key('blank-page-glyph', 'recovered'),
      key('empty-cached-glyph', 'recovered'),
      key('blank-page-glyph', 'suppressed')
    ])
    expect(keys.size).toBe(3)
  })
})
