import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isReady: () => false,
    userAgentFallback:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.4.264 Chrome/150.0.7871.250 Electron/43.8.10 Safari/537.36'
  }
}))

const { cleanElectronUserAgent, initializeBrowserProcessUserAgent } =
  await import('./browser-process-user-agent')

describe('initializeBrowserProcessUserAgent', () => {
  it('drops the app token but keeps the Electron token in native mode', () => {
    expect(initializeBrowserProcessUserAgent('native').userAgent).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.250 Electron/43.8.10 Safari/537.36'
    )
  })
})

describe('cleanElectronUserAgent', () => {
  it('strips the Electron and multi-word app tokens', () => {
    const raw =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) My Orca Build/1.0.0 Chrome/150.0.0.0 Electron/43.7.0 Safari/537.36'
    expect(cleanElectronUserAgent(raw)).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    )
  })

  it('leaves an OS comment without an engine comment unchanged', () => {
    const raw =
      'Mozilla/5.0 (X11; Linux x86_64) SomeEngine/1.0 MyApp/2.0 Chrome/150.0.0.0 Electron/43.7.0 Safari/537.36'
    expect(cleanElectronUserAgent(raw)).toBe(raw)
  })
})
