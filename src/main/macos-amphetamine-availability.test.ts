import { describe, expect, it } from 'vitest'
import { AmphetamineAvailability } from './macos-amphetamine-availability'

describe('AmphetamineAvailability', () => {
  it('starts usable', () => {
    const availability = new AmphetamineAvailability()

    expect(availability.get()).toBeNull()
    expect(availability.isUnavailable()).toBe(false)
  })

  it('reports a verdict as new only once', () => {
    const availability = new AmphetamineAvailability()

    expect(availability.mark('automation-denied')).toBe(true)
    expect(availability.mark('automation-denied')).toBe(false)
  })

  it('treats a different verdict as new', () => {
    const availability = new AmphetamineAvailability()
    availability.mark('automation-denied')

    expect(availability.mark('not-installed')).toBe(true)
    expect(availability.get()).toBe('not-installed')
  })

  it('clears only when there was a verdict to forget', () => {
    const availability = new AmphetamineAvailability()

    expect(availability.clear()).toBe(false)
    availability.mark('not-installed')
    expect(availability.clear()).toBe(true)
    expect(availability.isUnavailable()).toBe(false)
  })
})
