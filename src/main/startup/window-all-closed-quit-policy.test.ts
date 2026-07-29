import { describe, expect, it } from 'vitest'
import { shouldQuitWhenAllWindowsClosed } from './window-all-closed-quit-policy'

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
