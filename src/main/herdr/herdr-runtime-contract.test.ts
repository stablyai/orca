import { describe, expect, it } from 'vitest'
import { assertHerdrRuntimeCompatible } from './herdr-runtime-contract'

describe('Herdr runtime compatibility', () => {
  it('accepts the current unreleased protocol when the required capabilities are present', () => {
    expect(() =>
      assertHerdrRuntimeCompatible({
        protocol: 17,
        external_refs: true,
        resumable_events: true,
        portable_layouts: true,
        terminal_control_v2: true,
        terminal_history: true,
        controller_takeover: true,
        pane_restart: false
      })
    ).not.toThrow()
  })
})
