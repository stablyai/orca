import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isTrustedBrowserRenderer,
  setTrustedBrowserRendererWebContentsId
} from './browser-renderer-trust'

/** Packaged main-window sender stub (id 7, file:// URL); `overrides` replaces single members. */
function makeSender(overrides: Partial<Record<string, unknown>> = {}): Electron.WebContents {
  const sender = {
    id: 7,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///Applications/Orca.app/Contents/Resources/app/index.html',
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the trust check reads only the stubbed members.
  return sender as unknown as Electron.WebContents
}

describe('isTrustedBrowserRenderer', () => {
  afterEach(() => {
    setTrustedBrowserRendererWebContentsId(null)
    vi.unstubAllEnvs()
  })

  it('trusts only the pinned main renderer', () => {
    setTrustedBrowserRendererWebContentsId(7)
    expect(isTrustedBrowserRenderer(makeSender())).toBe(true)
    expect(isTrustedBrowserRenderer(makeSender({ id: 8 }))).toBe(false)
  })

  it('refuses any file:// sender when no renderer is pinned in packaged builds', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    setTrustedBrowserRendererWebContentsId(null)
    expect(isTrustedBrowserRenderer(makeSender())).toBe(false)
    expect(isTrustedBrowserRenderer(makeSender({ getURL: () => 'file:///tmp/page.html' }))).toBe(
      false
    )
  })

  it('keeps the dev-server origin fallback', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    expect(isTrustedBrowserRenderer(makeSender({ getURL: () => 'http://localhost:5173/x' }))).toBe(
      true
    )
    expect(isTrustedBrowserRenderer(makeSender({ getURL: () => 'http://evil.test/' }))).toBe(false)
  })
})
