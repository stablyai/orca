import { describe, expect, it } from 'vitest'
import { hasStructuredTuiIdleEvidence } from './structured-tui-idle-evidence'

describe('structured TUI idle evidence', () => {
  it('does not treat a ready prompt preview as proof that a turn is idle', () => {
    const readyPreview = ' >_ OpenAI Codex\n model: gpt-5.5\n directory: /workspace'
    expect(readyPreview).toContain('OpenAI Codex')
    expect(
      hasStructuredTuiIdleEvidence({ blocked: false, status: null, statusObservedLive: false })
    ).toBe(false)
  })

  it('requires an explicit idle state and still rejects blocked prompts', () => {
    expect(
      hasStructuredTuiIdleEvidence({ blocked: false, status: 'idle', statusObservedLive: true })
    ).toBe(true)
    expect(
      hasStructuredTuiIdleEvidence({ blocked: true, status: 'idle', statusObservedLive: true })
    ).toBe(false)
  })

  it('does not authorize a restored idle status before live observation', () => {
    expect(
      hasStructuredTuiIdleEvidence({ blocked: false, status: 'idle', statusObservedLive: false })
    ).toBe(false)
  })
})
