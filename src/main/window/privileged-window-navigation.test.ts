import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternal, openUrlInInstalledBrowser } = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openUrlInInstalledBrowser: vi.fn()
}))
vi.mock('electron', () => ({
  shell: { openExternal: (url: string) => openExternal(url) }
}))
vi.mock('../external-browsers/external-browser-launch', () => ({ openUrlInInstalledBrowser }))

import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'
import { setExternalBrowserSettingsReader } from '../external-browsers/open-external-url'

describe('privileged window navigation policy', () => {
  function createFixture(currentUrl: string) {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    let windowOpenHandler: ((details: { url: string }) => unknown) | undefined
    const contents = {
      getURL: () => currentUrl,
      setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => unknown) => {
        windowOpenHandler = handler
      }),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler)
      })
    }
    installPrivilegedWindowNavigationPolicy(contents as never)
    return {
      windowOpen(url: string) {
        if (!windowOpenHandler) {
          throw new Error('no window open handler was registered')
        }
        return windowOpenHandler({ url })
      },
      willNavigate(url: string) {
        const event = { preventDefault: vi.fn() }
        const handler = handlers.get('will-navigate')
        // Assert handler presence or missing navigation guards pass allow-cases vacuously.
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
    openUrlInInstalledBrowser.mockReset()
    setExternalBrowserSettingsReader(null)
  })

  it('opens window-open targets in the configured browser and denies the window', async () => {
    setExternalBrowserSettingsReader(() => ({ externalBrowserId: 'edge' }))
    openUrlInInstalledBrowser.mockResolvedValue(true)

    const result = createFixture('http://localhost:5173/').windowOpen('https://example.com/pr/1')

    expect(result).toEqual({ action: 'deny' })
    await vi.waitFor(() =>
      expect(openUrlInInstalledBrowser).toHaveBeenCalledWith('edge', 'https://example.com/pr/1')
    )
    expect(openExternal).not.toHaveBeenCalled()
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

  // The exact packaged file host/path defines privilege; foreign hosts and copied paths under other schemes must fail.
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
