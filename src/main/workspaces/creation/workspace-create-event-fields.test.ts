import { describe, expect, it } from 'vitest'

import { workspaceCreateTimingFields } from './workspace-create-event-fields'

const quiet = { otherCreates: 0, preparations: 0 }

describe('workspaceCreateTimingFields', () => {
  it('sums a repeated phase and drops names outside the closed vocabulary', () => {
    const fields = workspaceCreateTimingFields(
      {
        totalDurationMs: 100,
        phases: [
          { phase: 'refresh_base_ref', startedAtMs: 0, durationMs: 10 },
          { phase: 'refresh_base_ref', startedAtMs: 10, durationMs: 15 },
          { phase: '/Users/alice/repo', startedAtMs: 25, durationMs: 5 }
        ]
      },
      { entryPoint: 'app', concurrency: quiet }
    )

    expect(fields.refresh_base_ref_ms).toBe(25)
    expect(Object.keys(fields).some((key) => key.includes('alice'))).toBe(false)
  })
})
