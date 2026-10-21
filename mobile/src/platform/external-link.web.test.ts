/** The web form: the page has no way out of itself, so the shell is asked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openExternalLink, publishExternalLinkOpener } from './external-link.web'

let warned: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warned.mockRestore()
})

describe('opening a URL from inside the shell', () => {
  it('hands an allowed URL to whatever the entry published', () => {
    const asked: string[] = []
    publishExternalLinkOpener((url) => {
      asked.push(url)
      return true
    })
    openExternalLink('https://github.com/stablyai/orca')
    expect(asked).toEqual(['https://github.com/stablyai/orca'])
    expect(warned).not.toHaveBeenCalled()
  })

  it('names a scheme the grant does not cover and asks for nothing', () => {
    const asked: string[] = []
    publishExternalLinkOpener((url) => {
      asked.push(url)
      return true
    })
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', '/h/host-a/tasks']) {
      expect(() => openExternalLink(url), url).not.toThrow()
    }
    expect(asked).toEqual([])
    expect(warned).toHaveBeenCalledTimes(3)
  })

  it('names a shell that would not take it, rather than reporting a tap that did nothing', () => {
    publishExternalLinkOpener(() => false)
    openExternalLink('https://example.com')
    expect(warned.mock.calls[0]?.[0]).toBe('[page] the shell did not take a URL to open')
  })

  it('refuses everything in a document that published no opener', async () => {
    // A fresh module, because `post` is module state: every case above has already published one,
    // and without this the default at the top of the module is never the thing under test. The
    // reason is asserted for the same rule — `not.toThrow()` passes against any implementation.
    vi.resetModules()
    const fresh: typeof import('./external-link.web') = await import('./external-link.web')
    fresh.openExternalLink('https://example.com')
    expect(warned.mock.calls).toEqual([
      ['[page] the shell did not take a URL to open', { url: 'https://example.com' }]
    ])
  })
})
