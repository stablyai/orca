import { describe, expect, it } from 'vitest'
import {
  closingLastWindowQuitsApp,
  shouldQuitWhenAllWindowsClosed
} from './window-all-closed-quit-policy'

describe('shouldQuitWhenAllWindowsClosed', () => {
  it('keeps headless serve alive when its offscreen browser windows close', () => {
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: 'linux',
        isQuitting: false,
        isServeMode: true
      })
    ).toBe(false)
  })

  it('keeps normal macOS close-all behavior outside quit', () => {
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: 'darwin',
        isQuitting: false,
        isServeMode: false
      })
    ).toBe(false)
  })

  it('quits desktop Linux when all windows close', () => {
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: 'linux',
        isQuitting: false,
        isServeMode: false
      })
    ).toBe(true)
  })

  it('continues a committed quit on macOS after all windows close', () => {
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: 'darwin',
        isQuitting: true,
        isServeMode: false
      })
    ).toBe(true)
  })

  it('continues a committed quit after a serve owner was promoted to desktop', () => {
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: 'darwin',
        isQuitting: true,
        isServeMode: true
      })
    ).toBe(true)
  })
})

describe('closingLastWindowQuitsApp', () => {
  it('is true on Windows and Linux desktop, where the X button ends the app', () => {
    expect(closingLastWindowQuitsApp({ platform: 'win32', isServeMode: false })).toBe(true)
    expect(closingLastWindowQuitsApp({ platform: 'linux', isServeMode: false })).toBe(true)
  })

  it('is false on macOS, where the app outlives its last window', () => {
    expect(closingLastWindowQuitsApp({ platform: 'darwin', isServeMode: false })).toBe(false)
  })

  it('is false for a serve host, which keeps running with no window', () => {
    expect(closingLastWindowQuitsApp({ platform: 'win32', isServeMode: true })).toBe(false)
  })
})
