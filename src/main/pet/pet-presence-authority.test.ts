import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => '/tmp/orca-pet-presence-test'
}))
// Persistence is exercised by the fs-utils suite; here it would only add disk
// churn to every assertion about exclusivity.
vi.mock('../codex-accounts/fs-utils', () => ({ writeFileAtomically: () => {} }))

const { petPresenceAuthority } = await import('./pet-presence-authority')

describe('pet presence authority', () => {
  beforeEach(() => {
    petPresenceAuthority.resetForTests()
  })

  it('adopts the first surface that registers', () => {
    const state = petPresenceAuthority.registerSurface('desk-1', 'desktop-window')
    expect(state.presence.surfaceId).toBe('desk-1')
    expect(state.surfaces).toHaveLength(1)
  })

  it('does not move the pet when a second surface registers', () => {
    petPresenceAuthority.registerSurface('desk-1', 'desktop-window')
    const state = petPresenceAuthority.registerSurface('desk-2', 'desktop-window')
    expect(state.presence.surfaceId).toBe('desk-1')
  })

  // THE P1 GATE: two desktop surfaces must never both believe they hold the pet.
  it('keeps exactly one holder across a handoff between two desktop surfaces', () => {
    petPresenceAuthority.registerSurface('desk-1', 'desktop-window')
    petPresenceAuthority.registerSurface('desk-2', 'desktop-window')

    const after = petPresenceAuthority.reportExit('desk-1', 'right', { x: 1, y: 0.5 })
    expect(after.presence.surfaceId).toBe('desk-2')

    const holders = after.surfaces.filter((s) => s.id === after.presence.surfaceId)
    expect(holders).toHaveLength(1)
  })

  it('ignores an exit from a surface that does not hold the pet', () => {
    petPresenceAuthority.registerSurface('desk-1', 'desktop-window')
    petPresenceAuthority.registerSurface('phone-1', 'phone')

    const after = petPresenceAuthority.reportExit('phone-1', 'left', { x: 0, y: 0.5 })
    expect(after.presence.surfaceId).toBe('desk-1')
  })

  it('does not move the pet when there is nowhere to hand off to', () => {
    petPresenceAuthority.registerSurface('desk-1', 'desktop-window')
    const after = petPresenceAuthority.reportExit('desk-1', 'right', { x: 1, y: 0.5 })
    expect(after.presence.surfaceId).toBe('desk-1')
  })

  it('rescues the pet when its holder is removed', () => {
    petPresenceAuthority.registerSurface('desk-1', 'desktop-window')
    petPresenceAuthority.registerSurface('phone-1', 'phone')
    petPresenceAuthority.removeSurface('desk-1')

    const state = petPresenceAuthority.getState()
    expect(state.presence.surfaceId).toBe('phone-1')
    expect(state.surfaces.map((s) => s.id)).toEqual(['phone-1'])
  })

  it('claims the pet onto a live surface but not a stranger', () => {
    petPresenceAuthority.registerSurface('desk-1', 'desktop-window')
    petPresenceAuthority.registerSurface('phone-1', 'phone')

    expect(petPresenceAuthority.claim('phone-1').presence.surfaceId).toBe('phone-1')
    // A surface that never registered cannot summon the pet into a dead window.
    expect(petPresenceAuthority.claim('ghost').presence.surfaceId).toBe('phone-1')
  })

  it('clears the arrival marker only for the surface holding the pet', () => {
    petPresenceAuthority.registerSurface('desk-1', 'desktop-window')
    petPresenceAuthority.registerSurface('phone-1', 'phone')
    petPresenceAuthority.reportExit('desk-1', 'right', { x: 1, y: 0.5 })
    expect(petPresenceAuthority.getState().presence.enteredFromEdge).toBe('left')

    petPresenceAuthority.acknowledgeEntry('desk-1')
    expect(petPresenceAuthority.getState().presence.enteredFromEdge).toBe('left')

    petPresenceAuthority.acknowledgeEntry('phone-1')
    expect(petPresenceAuthority.getState().presence.enteredFromEdge).toBeNull()
  })

  it('notifies subscribers on a handoff and stops after unsubscribe', () => {
    const seen: (string | null)[] = []
    const unsubscribe = petPresenceAuthority.subscribe((snapshot) => {
      seen.push(snapshot.presence.surfaceId)
    })
    petPresenceAuthority.registerSurface('desk-1', 'desktop-window')
    petPresenceAuthority.registerSurface('phone-1', 'phone')
    petPresenceAuthority.reportExit('desk-1', 'right', { x: 1, y: 0.5 })
    expect(seen.at(-1)).toBe('phone-1')

    unsubscribe()
    const before = seen.length
    petPresenceAuthority.reportExit('phone-1', 'left', { x: 0, y: 0.5 })
    expect(seen).toHaveLength(before)
  })

  it('survives a subscriber that throws', () => {
    petPresenceAuthority.subscribe(() => {
      throw new Error('bad subscriber')
    })
    const seen: string[] = []
    petPresenceAuthority.subscribe((snapshot) => {
      if (snapshot.presence.surfaceId) {
        seen.push(snapshot.presence.surfaceId)
      }
    })
    expect(() => petPresenceAuthority.registerSurface('desk-1', 'desktop-window')).not.toThrow()
    expect(seen).toContain('desk-1')
  })
})
