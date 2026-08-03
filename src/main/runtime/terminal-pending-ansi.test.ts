import { describe, expect, it } from 'vitest'
import { retainTerminalPendingAnsi } from './terminal-pending-ansi'

describe('retainTerminalPendingAnsi', () => {
  it('bounds an incomplete control while preserving its introducer and suffix', () => {
    expect(retainTerminalPendingAnsi(`\x1b]${'x'.repeat(5000)}`)).toBe(`\x1b]${'x'.repeat(4094)}`)
  })
})
