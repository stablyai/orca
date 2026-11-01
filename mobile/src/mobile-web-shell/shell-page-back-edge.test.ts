import { describe, expect, it } from 'vitest'
import { shellBackEdgeClaims, shellBackEdgePops } from './shell-back-edge'

describe('the left-edge swipe that stands in for the native stack', () => {
  it('claims a horizontal move and ignores a vertical one', () => {
    expect(shellBackEdgeClaims(20, 4)).toBe(true)
    expect(shellBackEdgeClaims(12, 0)).toBe(false)
    expect(shellBackEdgeClaims(30, 40)).toBe(false)
    expect(shellBackEdgeClaims(-20, 0)).toBe(false)
  })

  it('pops only after a far enough horizontal move', () => {
    expect(shellBackEdgePops(64, 0)).toBe(true)
    expect(shellBackEdgePops(80, 70)).toBe(true)
    expect(shellBackEdgePops(63, 0)).toBe(false)
    expect(shellBackEdgePops(80, 80)).toBe(false)
    expect(shellBackEdgePops(-64, 0)).toBe(false)
  })
})
