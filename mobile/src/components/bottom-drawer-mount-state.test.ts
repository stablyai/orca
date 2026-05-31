import { describe, expect, it } from 'vitest'
import { resolveBottomDrawerMounted } from './bottom-drawer-mount-state'

describe('resolveBottomDrawerMounted', () => {
  it('mounts before opening and stays mounted while closing', () => {
    expect(resolveBottomDrawerMounted(true, false)).toBe(true)
    expect(resolveBottomDrawerMounted(true, true)).toBe(true)
    expect(resolveBottomDrawerMounted(false, true)).toBe(true)
    expect(resolveBottomDrawerMounted(false, false)).toBe(false)
  })
})
