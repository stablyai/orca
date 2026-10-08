import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isReady: () => false, userAgentFallback: '' } }))

const { cleanElectronUserAgent } = await import('./browser-process-user-agent')

const MAC_CLEAN =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
const LINUX_CLEAN =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

describe('cleanElectronUserAgent', () => {
  // Why each shape: app.setName decides this token, and dev sets a name containing a space
  // ("Orca Dev"). A cleaner that only removes a single whitespace-delimited token leaves the
  // app name on the wire in exactly the builds we test with.
  it.each([
    [
      'a one-word app name',
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Orca/1.4.203 Chrome/150.0.0.0 Electron/43.7.0 Safari/537.36`,
      MAC_CLEAN
    ],
    [
      'an app name containing a space',
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Orca Dev/1.4.203 Chrome/150.0.0.0 Electron/43.7.0 Safari/537.36`,
      MAC_CLEAN
    ],
    [
      'an app name containing two spaces',
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) My Orca Build/1.0.0 Chrome/150.0.0.0 Electron/43.7.0 Safari/537.36`,
      LINUX_CLEAN
    ],
    [
      'no app token at all',
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Electron/43.7.0 Safari/537.36`,
      MAC_CLEAN
    ],
    [
      'an app name after the engine comment on a platform with a short OS comment',
      `Mozilla/5.0 (Test) AppleWebKit/537.36 (KHTML, like Gecko) Package/0.0.0 Chrome/150.0.0.0 Electron/43.7.0 Safari/537.36`,
      'Mozilla/5.0 (Test) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    ]
  ])('strips the Electron and app tokens for %s', (_label, raw, expected) => {
    expect(cleanElectronUserAgent(raw)).toBe(expected)
  })

  it('leaves an already-clean identity byte-identical', () => {
    expect(cleanElectronUserAgent(MAC_CLEAN)).toBe(MAC_CLEAN)
  })

  // Why: over-stripping is worse than under-stripping — without the engine comment the app-token
  // anchor lands on the OS comment and destroys a real engine token, so these are left alone.
  it.each([
    [
      'an OS comment but no engine comment',
      'Mozilla/5.0 (X11; Linux x86_64) SomeEngine/1.0 MyApp/2.0 Chrome/150.0.0.0 Electron/43.7.0 Safari/537.36'
    ],
    ['no comment at all', 'SomeOtherAgent/2.0 Chrome/150.0.0.0 Safari/537.36'],
    [
      'a non-Chromium user agent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0'
    ]
  ])('leaves a user agent unchanged for %s', (_label, raw) => {
    expect(cleanElectronUserAgent(raw)).toBe(raw)
  })
})
