import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserGuestMetadata } from '../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import type { BrowserLoadError } from '../../../../shared/browser/workspaces/browser-workspace-types'
import {
  installBrowserGuestMetadata,
  publishBrowserGuestMetadata,
  readBrowserGuestMetadata
} from './browser-guest-metadata'

function fixture() {
  let url = 'https://example.test/start'
  let title = 'Start'
  let loading = false
  let back = false
  let loadError: BrowserLoadError | null = null
  const emitter = new EventEmitter()
  const guest = Object.assign(emitter, {
    id: 42,
    isDestroyed: () => false,
    getURL: () => url,
    getTitle: () => title,
    isLoadingMainFrame: () => loading,
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
    setLoading: (value: boolean) => {
      loading = value
    },
    setBack: () => {
      back = true
    }
  }
}

describe('native guest metadata', () => {
  it('publishes, caches and retires safe metadata while the native guest keeps its private destination', () => {
    const f = fixture()
    const raw = 'https://kagi.com/redirected?token=test-only&q=one'
    f.navigate(raw, raw)
    f.guest.emit('did-navigate', {}, raw)
    expect(f.reports.at(-1)).toMatchObject({
      url: 'https://kagi.com/redirected?q=one',
      title: 'https://kagi.com/redirected?q=one'
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the native methods the production reader uses.
    expect(readBrowserGuestMetadata(f.guest as unknown as Electron.WebContents)?.url).toBe(
      'https://kagi.com/redirected?q=one'
    )
    expect(f.guest.getURL()).toBe(raw)
    f.dispose()
    expect(f.reports.at(-1)?.kind).toBe('retired')
    expect(JSON.stringify(f.reports)).not.toContain('test-only')
  })
})
