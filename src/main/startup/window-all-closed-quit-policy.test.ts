import { describe, expect, it } from 'vitest'
import {
  shouldCommitDesktopQuit,
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

describe('shouldCommitDesktopQuit', () => {
  it('does not quit the serve process on a desktop Cmd+Q', () => {
    expect(
      shouldCommitDesktopQuit({
        isServeMode: true,
        isUpdateQuit: false
      })
    ).toBe(false)
  })

  it('still quits a normal desktop app', () => {
    expect(
      shouldCommitDesktopQuit({
        isServeMode: false,
        isUpdateQuit: false
      })
    ).toBe(true)
  })

  it('still allows an update-install quit in serve mode', () => {
    expect(
      shouldCommitDesktopQuit({
        isServeMode: true,
        isUpdateQuit: true
      })
    ).toBe(true)
  })
})
