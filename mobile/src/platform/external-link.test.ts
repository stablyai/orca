/** The native form of the seam: the app's own `Linking`, and nothing between a screen and it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const linking = vi.hoisted(() => ({ openURL: vi.fn(() => Promise.resolve(true)) }))

vi.mock('react-native', () => ({ Linking: linking }))

import { openExternalLink } from './external-link'

beforeEach(() => {
  linking.openURL.mockReset()
  linking.openURL.mockReturnValue(Promise.resolve(true))
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
    linking.openURL.mockReturnValue(Promise.reject(new Error('no activity found')))
    expect(() => openExternalLink('mailto:someone@example.com')).not.toThrow()
    // The rejection is settled rather than left to the unhandled-rejection handler.
    await Promise.resolve()
  })

  it('checks no scheme of its own, because on a phone this is what every call site already did', () => {
    openExternalLink('orca://x')
    expect(linking.openURL.mock.calls).toEqual([['orca://x']])
  })
})
