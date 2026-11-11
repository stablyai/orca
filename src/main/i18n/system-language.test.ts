import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPreferredSystemLanguages, isReady } = vi.hoisted(() => ({
  getPreferredSystemLanguages: vi.fn(),
  isReady: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPreferredSystemLanguages, isReady } }))

beforeEach(() => {
  vi.resetModules()
  isReady.mockReturnValue(true)
  getPreferredSystemLanguages.mockReturnValue(['fr-FR', 'en-US'])
})

describe('native language snapshot', () => {
  it('reads preferences once after app readiness and shares the ordered result', async () => {
    const { getSystemLanguageDetection } = await import('./system-language')
    isReady.mockReturnValue(false)
    getPreferredSystemLanguages.mockReturnValueOnce(['ja-JP'])
    // Pre-ready reads serve startup-failure dialogs without pinning the post-ready snapshot.
    expect(getSystemLanguageDetection()?.locale).toBe('ja')
    isReady.mockReturnValue(true)
    expect(getSystemLanguageDetection()).toMatchObject({
      detectedTag: 'fr-FR',
      locale: 'fr',
      source: 'native'
    })
    getPreferredSystemLanguages.mockReturnValue(['en-US'])
    expect(getSystemLanguageDetection()?.locale).toBe('fr')
    expect(getPreferredSystemLanguages).toHaveBeenCalledTimes(2)
  })
})
