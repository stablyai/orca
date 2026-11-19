import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isReady: () => false, userAgentFallback: '' } }))

const { cleanElectronUserAgent } = await import('./browser-process-user-agent')

const MAC_CLEAN =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
const LINUX_CLEAN =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

describe('cleanElectronUserAgent', () => {
  it.each([
    [
      'an app name containing two spaces',
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) My Orca Build/1.0.0 Chrome/150.0.0.0 Electron/43.7.0 Safari/537.36`,
      LINUX_CLEAN
    ],
    [
      'no app token at all',
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Electron/43.7.0 Safari/537.36`,
      MAC_CLEAN
    ]
  ])('strips the Electron and app tokens for %s', (_label, raw, expected) => {
    expect(cleanElectronUserAgent(raw)).toBe(expected)
  })

  it('leaves an OS comment without an engine comment unchanged', () => {
    const raw =
      'Mozilla/5.0 (X11; Linux x86_64) SomeEngine/1.0 MyApp/2.0 Chrome/150.0.0.0 Electron/43.7.0 Safari/537.36'
    expect(cleanElectronUserAgent(raw)).toBe(raw)
  })
})
