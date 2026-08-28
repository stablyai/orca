import { beforeEach, describe, expect, it, vi } from 'vitest'

const openExternal = vi.fn()
vi.mock('electron', () => ({
  shell: { openExternal: (url: string) => openExternal(url) }
}))

import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'

describe('privileged window navigation policy', () => {
  function createFixture(currentUrl: string) {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const contents = {
      getURL: () => currentUrl,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler)
      })
    }
    installPrivilegedWindowNavigationPolicy(contents as never)
    return {
      willNavigate(url: string) {
        const event = { preventDefault: vi.fn() }
        const handler = handlers.get('will-navigate')
        // Why: the allow-cases assert preventDefault was *not* called, so a missing
        // handler would pass them vacuously.
        if (!handler) {
          throw new Error('no will-navigate handler was registered')
        }
        handler(event, url)
        return event
      }
    }
  }

  beforeEach(() => {
    openExternal.mockClear()
  })

  it('lets the packaged renderer document reload itself', () => {
    const appUrl =
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
    const event = createFixture(appUrl).willNavigate(appUrl)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('still blocks and hands off an external http target', () => {
    const appUrl =
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
    const event = createFixture(appUrl).willNavigate('https://example.com/')

    expect(event.preventDefault).toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('lets the dev renderer origin navigate but blocks foreign documents', () => {
    const fixture = createFixture('http://localhost:5173/')

    expect(
      fixture.willNavigate('http://localhost:5173/index.html').preventDefault
    ).not.toHaveBeenCalled()
    expect(fixture.willNavigate('https://example.com/').preventDefault).toHaveBeenCalled()
    expect(
      fixture.willNavigate('blob:http://localhost:5173/attacker-document').preventDefault
    ).toHaveBeenCalled()
  })

  // Why: the packaged file: path is the whole privilege boundary, so a foreign host or a
  // non-file scheme that reuses it must not read as "our own document".
  it('blocks a foreign file host and a data: URL that reuse the renderer path', () => {
    const appUrl =
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
    const fixture = createFixture(appUrl)

    expect(
      fixture.willNavigate(
        'file://evil.example/Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
      ).preventDefault
    ).toHaveBeenCalled()
    expect(
      fixture.willNavigate('data:text/html,<script>1</script>').preventDefault
    ).toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('still blocks navigation to an unrelated local file', () => {
    const appUrl =
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
    const event = createFixture(appUrl).willNavigate('file:///Users/someone/.ssh/id_rsa')

    expect(event.preventDefault).toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })
})
