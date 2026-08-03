import { describe, expect, it, vi } from 'vitest'
import { QuitTeardownStartGate } from './quit-teardown-start-gate'

describe('QuitTeardownStartGate', () => {
  it('starts teardown once while vetoing every overlapping quit', () => {
    const gate = new QuitTeardownStartGate()
    const first = { preventDefault: vi.fn() }
    const second = { preventDefault: vi.fn() }

    expect(gate.tryStart(first)).toBe(true)
    expect(gate.tryStart(second)).toBe(false)
    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    expect(second.preventDefault).toHaveBeenCalledTimes(1)
  })
})
