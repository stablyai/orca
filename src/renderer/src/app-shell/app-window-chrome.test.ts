import { describe, expect, it } from 'vitest'
import {
  hasCustomTitleBar,
  resolveCustomWindowControlsSide,
  shortcutPlatform,
  windowControlsSideInsets
} from './app-window-chrome'

describe('windowControlsSideInsets', () => {
  it('places the cluster on the requested side when custom chrome is active', () => {
    if (!hasCustomTitleBar) {
      expect(windowControlsSideInsets('left')).toEqual({
        left: '0px',
        right: '0px',
        rightEdgeHeight: '0px'
      })
      return
    }
    const right = windowControlsSideInsets('right')
    const left = windowControlsSideInsets('left')
    expect(right.right).not.toBe('0px')
    expect(right.left).toBe('0px')
    expect(right.rightEdgeHeight).not.toBe('0px')
    expect(left.left).toBe(right.right)
    expect(left.right).toBe('0px')
    expect(left.rightEdgeHeight).toBe('0px')
  })
})

describe('resolveCustomWindowControlsSide', () => {
  it('only honors left when custom Linux chrome is active', () => {
    const resolved = resolveCustomWindowControlsSide('left')
    if (!hasCustomTitleBar) {
      expect(resolved).toBe('right')
      return
    }
    // Why: match shortcutPlatform (navigator.userAgent), not process.platform — Vitest's UA is not the host OS.
    expect(resolved).toBe(shortcutPlatform === 'linux' ? 'left' : 'right')
  })
})
