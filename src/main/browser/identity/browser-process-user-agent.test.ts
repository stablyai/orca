import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isReady: () => false, userAgentFallback: '' } }))

const { cleanElectronUserAgent } = await import('./browser-process-user-agent')

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
