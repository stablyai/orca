/** The native form of the seam: the app's own `Linking`, and nothing between a screen and it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `openURL` validates synchronously before it returns a promise, so an empty string throws past
 * any `.catch` attached to the result: `Linking.openURL` calls `_validateURL`, which is
 * `invariant(url, 'Invalid URL: cannot be empty')` (react-native 0.83.10,
 * `Libraries/Linking/Linking.js:117-123`). The double mirrors that, because a mock that only
 * rejects cannot reproduce the one failure that escapes a tap handler.
 */
const linking = vi.hoisted(() => {
  const validatingOpen = (url: string): Promise<boolean> => {
    if (url === '') {
      throw new Error('Invalid URL: cannot be empty')
    }
    return Promise.resolve(true)
  }
  return { validatingOpen, openURL: vi.fn(validatingOpen) }
})

vi.mock('react-native', () => ({ Linking: { openURL: linking.openURL } }))

import { openExternalLink } from './external-link'

beforeEach(() => {
  linking.openURL.mockReset()
  // Restored, not replaced with a plain resolve: a double that skips the synchronous validation
  // cannot reproduce the one failure that escapes a tap handler.
  linking.openURL.mockImplementation(linking.validatingOpen)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('opening a URL from a phone screen', () => {
  it('hands it straight to the app, unchanged', () => {
    openExternalLink('https://github.com/stablyai/orca/pull/1')
    expect(linking.openURL.mock.calls).toEqual([['https://github.com/stablyai/orca/pull/1']])
  })

  it('does not throw out of a tap handler when nothing can open the URL', async () => {
    linking.openURL.mockImplementation(() => Promise.reject(new Error('no activity found')))
    expect(() => openExternalLink('mailto:someone@example.com')).not.toThrow()
    // The rejection is settled rather than left to the unhandled-rejection handler.
    await Promise.resolve()
  })

  it('checks no scheme of its own, because on a phone this is what every call site already did', () => {
    openExternalLink('orca://x')
    expect(linking.openURL.mock.calls).toEqual([['orca://x']])
  })
})

describe('a URL the platform refuses before it returns a promise', () => {
  it('does not throw out of a tap handler for an empty string', () => {
    expect(() => openExternalLink('')).not.toThrow()
  })

  it('names the refusal rather than failing silently', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    openExternalLink('')
    expect(warned).toHaveBeenCalled()
    warned.mockRestore()
  })
})
