import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mirror RN 0.83.10 openURL’s synchronous empty-URL validation; a promise-only rejecting mock cannot expose throws that escape .catch.
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
  // Restore synchronous validation too so later tests can still reproduce the escaping throw.
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
    expect(warned.mock.calls).toEqual([
      [
        '[platform] could not open a URL',
        { url: '' },
        expect.objectContaining({ message: 'Invalid URL: cannot be empty' })
      ]
    ])
    warned.mockRestore()
  })
})
