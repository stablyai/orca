import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'

const openExternalMock = vi.hoisted(() => vi.fn())
const isMock = vi.hoisted(() => ({ dev: false }))

vi.mock('electron', () => ({
  shell: { openExternal: openExternalMock }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

const PACKAGED_DOCUMENT_URL =
  'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
const WINDOWS_DOCUMENT_URL =
  'file:///C:/Users/dev/AppData/Local/Programs/orca/resources/app.asar/out/renderer/index.html'

type NavigationHandler = (event: { preventDefault: () => void }, url: string) => void

function installPolicy(currentUrl: string): NavigationHandler {
  const handlers: Record<string, NavigationHandler> = {}
  const contents = {
    setWindowOpenHandler: vi.fn(),
    getURL: vi.fn(() => currentUrl),
    on: vi.fn((event: string, handler: NavigationHandler) => {
      handlers[event] = handler
    })
  }
  installPrivilegedWindowNavigationPolicy(contents as unknown as WebContents)
  return handlers['will-navigate']
}

describe('installPrivilegedWindowNavigationPolicy', () => {
  beforeEach(() => {
    openExternalMock.mockClear()
    isMock.dev = false
    // Why: a dev shell exports this; stub (not mutate) so the value is restored for other suites.
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('lets the renderer reload its own packaged document', () => {
    const willNavigate = installPolicy(PACKAGED_DOCUMENT_URL)
    const preventDefault = vi.fn()

    willNavigate({ preventDefault }, PACKAGED_DOCUMENT_URL)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('lets a Windows renderer reload its exact packaged document', () => {
    const willNavigate = installPolicy(WINDOWS_DOCUMENT_URL)
    const preventDefault = vi.fn()

    willNavigate({ preventDefault }, WINDOWS_DOCUMENT_URL)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('blocks a case-divergent Windows path instead of weakening file identity', () => {
    const willNavigate = installPolicy(WINDOWS_DOCUMENT_URL)
    const preventDefault = vi.fn()

    willNavigate({ preventDefault }, WINDOWS_DOCUMENT_URL.replace('index.html', 'INDEX.HTML'))

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('lets the dashboard pop-out reload its own query-bearing document', () => {
    const popoutUrl =
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/popout.html?view=kanban'
    const willNavigate = installPolicy(popoutUrl)
    const preventDefault = vi.fn()

    willNavigate({ preventDefault }, popoutUrl)

    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('still blocks a different local file from the packaged document', () => {
    const willNavigate = installPolicy(PACKAGED_DOCUMENT_URL)
    const preventDefault = vi.fn()

    willNavigate({ preventDefault }, 'file:///etc/passwd')

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('still blocks remote navigation and hands it to the OS browser', () => {
    const willNavigate = installPolicy(PACKAGED_DOCUMENT_URL)
    const preventDefault = vi.fn()

    willNavigate({ preventDefault }, 'https://example.com/docs')

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('lets the dev server reload its own origin', () => {
    isMock.dev = true
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    const willNavigate = installPolicy('http://localhost:5173/index.html')
    const preventDefault = vi.fn()

    willNavigate({ preventDefault }, 'http://localhost:5173/login')

    expect(preventDefault).not.toHaveBeenCalled()
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('still blocks a sibling packaged document', () => {
    const willNavigate = installPolicy(PACKAGED_DOCUMENT_URL)
    const preventDefault = vi.fn()

    willNavigate(
      { preventDefault },
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/popout.html'
    )

    expect(preventDefault).toHaveBeenCalledTimes(1)
  })
})
