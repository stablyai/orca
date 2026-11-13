import { describe, expect, it } from 'vitest'
import { decodeClaudeTurnLifecycle } from './transcript-turn-lifecycle'

describe('native chat transcript turn lifecycle', () => {
  it('excludes Claude tool-result rows that also carry text sidecars', () => {
    expect(
      decodeClaudeTurnLifecycle(
        JSON.stringify({
          type: 'user',
          uuid: 'mixed-tool-result',
          timestamp: '2026-07-16T23:45:38.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
              { type: 'text', text: '<system-reminder>continue</system-reminder>' }
            ]
          }
        }),
        'fallback'
      )
    ).toBeNull()
  })
})
