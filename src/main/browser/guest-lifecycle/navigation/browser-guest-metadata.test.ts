import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserGuestMetadata } from '../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import type { BrowserLoadError } from '../../../../shared/browser-workspace-types'
import { installBrowserGuestMetadata, publishBrowserGuestMetadata } from './browser-guest-metadata'

function fixture() {
  let url = 'https://example.test/start'
  let title = 'Start'
  let back = false
  let loadError: BrowserLoadError | null = null
  const emitter = new EventEmitter()
  const guest = Object.assign(emitter, {
    id: 42,
    isDestroyed: () => false,
    getURL: () => url,
    getTitle: () => title,
    isLoadingMainFrame: () => false,
    navigationHistory: { canGoBack: () => back, canGoForward: () => false }
  })
  const reports: BrowserGuestMetadata[] = []
  const reportErrorPage = vi.fn(() => {
    loadError = {
      code: -1,
      description: 'This site could not be reached.',
      validatedUrl: 'https://broken.test/'
    }
  })
  const dispose = installBrowserGuestMetadata({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native event emitter with every method read by the metadata projection.
    guest: guest as unknown as Electron.WebContents,
    resolveOwner: () => 'page',
    readLoadError: () => loadError,
    hasCertificateFailure: () => false,
    reportErrorPage,
    send: (state) => reports.push(state)
  })
  return {
    guest,
    reports,
    dispose,
    reportErrorPage,
    navigate: (nextUrl: string, nextTitle: string) => {
      url = nextUrl
      title = nextTitle
    },
    setBack: () => {
      back = true
    }
  }
}

describe('native guest metadata', () => {
  it('projects same-URL native history and retains it through a failed destination without publishing Chromium internals', () => {
    const f = fixture()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the production publisher native methods.
    publishBrowserGuestMetadata(f.guest as unknown as Electron.WebContents)
    f.guest.emit('did-start-navigation', {}, 'https://iframe.test/', false, false)
    expect(f.reports.at(-1)?.loading).toBe(false)
    f.setBack()
    f.guest.emit('did-navigate-in-page', {}, 'https://example.test/start', true)
    expect(f.reports.at(-1)?.canGoBack).toBe(true)
    f.guest.emit('did-start-navigation', {}, 'https://broken.test/', false, true)
    f.navigate('chrome-error://chromewebdata/', 'chrome-error://chromewebdata/')
    f.guest.emit('page-title-updated', {}, 'chrome-error://chromewebdata/')
    // Some builds omit did-fail-load: native settlement must still provide the error.
    f.guest.emit('did-stop-loading')
    expect(f.reports.at(-1)).toMatchObject({
      url: 'https://example.test/start',
      title: 'Start',
      loading: false,
      canGoBack: true,
      errorPage: true,
      loadError: { code: -1, validatedUrl: 'https://broken.test/' }
    })
    f.dispose()
  })

  it('delivers unchanged-field commits and the stop after an aborted navigation', () => {
    const f = fixture()
    f.guest.emit('did-start-navigation', {}, 'https://example.test/start', false, true)
    f.guest.emit('did-navigate', {}, 'https://example.test/start')
    expect(f.reports.at(-1)?.kind).toBe('navigation')
    f.setBack()
    f.guest.emit('did-navigate-in-page', {}, 'https://example.test/start', true)
    f.guest.emit('did-navigate-in-page', {}, 'https://example.test/start', true)
    expect(f.reports.slice(-2).map((state) => state.navigationRevision)).toEqual([2, 3])
    f.guest.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://download.test/file.zip', true)
    f.guest.emit('did-stop-loading')
    expect(f.reports.at(-1)).toMatchObject({ kind: 'stop', loading: false, loadError: null })
    f.dispose()
  })
})
