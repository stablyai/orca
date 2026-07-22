import { describe, expect, it } from 'vitest'
import { PetSurfaceOwnership } from './pet-surface-ownership'

describe('PetSurfaceOwnership', () => {
  it('signals only the first surface per webContents so one listener is attached', () => {
    const own = new PetSurfaceOwnership()
    // The `destroyed` listener must be attached exactly once per renderer;
    // attaching it on every registerSurface would stack duplicate evictions.
    expect(own.add(1, 'surface-a')).toBe(true)
    expect(own.add(1, 'surface-b')).toBe(false)
  })

  it('evicts every surface a destroyed renderer owned', () => {
    const own = new PetSurfaceOwnership()
    own.add(7, 'popout-pet')
    own.add(7, 'popout-aux')
    expect(own.evictAll(7).sort()).toEqual(['popout-aux', 'popout-pet'])
  })

  it('is idempotent — a second eviction (or one after a clean forget) yields nothing', () => {
    // The real path can fire both a clean removeSurface AND the destroyed
    // listener; the second must be a no-op, not a double removeSurface.
    const own = new PetSurfaceOwnership()
    own.add(3, 'only')
    own.forget(3, 'only')
    expect(own.evictAll(3)).toEqual([])
  })

  it('does not evict a live renderer when another is destroyed', () => {
    const own = new PetSurfaceOwnership()
    own.add(1, 'desk')
    own.add(2, 'popout')
    expect(own.evictAll(2)).toEqual(['popout'])
    // The desktop renderer's surface is untouched.
    expect(own.evictAll(1)).toEqual(['desk'])
  })
})
