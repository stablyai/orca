import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'

const mocks = vi.hoisted(() => ({
  attachGuestPolicies: vi.fn(),
  installNavigationPolicy: vi.fn(),
  isAllowedPartition: vi.fn(),
  attachRouteGuest: vi.fn(),
  registerPluginGuard: vi.fn()
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: { attachGuestPolicies: mocks.attachGuestPolicies }
}))
vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: { isAllowedPartition: mocks.isAllowedPartition }
}))
vi.mock('../plugins/plugin-panel-navigation-guard', () => ({
  registerPluginPanelNavigationGuard: mocks.registerPluginGuard
}))
vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: mocks.installNavigationPolicy
}))
vi.mock('../browser/browser-route-session-runtime', () => ({
  browserRouteSessionRegistry: { isAllowedPartition: () => false },
  browserRouteWebContentsRegistry: { attachGuest: mocks.attachRouteGuest }
}))
vi.mock('../browser/local-ssh-browser-partitions', () => ({
  isLocalSshBrowserPartition: () => false,
  enforceLocalSshWebRtcPolicyForGuest: vi.fn()
}))
vi.mock('../browser/doc-preview-protocol', () => ({
  isDocPreviewSession: (candidate: unknown) => candidate === 'doc-preview-session'
}))

import { installMainWindowWebviewSecurity } from './main-window-webview-security'
import {
  getDocPreviewGrant,
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../browser/doc-preview-grant-registry'
import {
  publishDocPreviewFailure,
  setDocPreviewFailureSink
} from '../browser/doc-preview-failure-notice'
import { buildDocPreviewUrl, DOC_PREVIEW_PARTITION } from '../../shared/doc-preview-scheme'

function installOnFakeWindow(): {
  handlers: Record<string, (...args: never[]) => void>
  webContents: { on: ReturnType<typeof vi.fn> }
} {
  const handlers: Record<string, (...args: never[]) => void> = {}
  const webContents = {
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      handlers[event] = handler
    })
  }
  installMainWindowWebviewSecurity({ webContents } as never)
  return { handlers, webContents }
}

function mintPreviewGrant(): ReturnType<typeof mintDocPreviewGrant> {
  return mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html',
    browserPageId: 'page-1'
  })
}

describe('main window webview security', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    revokeAllDocPreviewGrants()
  })

  it('fails closed before applying hardened guest preferences', () => {
    const { handlers, webContents } = installOnFakeWindow()
    mocks.isAllowedPartition.mockReturnValue(false)
    const preventDefault = vi.fn()

    handlers['will-attach-webview']?.(
      { preventDefault } as never,
      { partition: 'persist:untrusted', preload: 'attacker.js' } as never,
      { src: 'https://example.com', preload: 'attacker.js' } as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(mocks.installNavigationPolicy).toHaveBeenCalledWith(webContents)
    expect(mocks.registerPluginGuard).toHaveBeenCalledWith(webContents)
  })

  it('removes renderer preload input and restores every hardened preference', () => {
    const { handlers } = installOnFakeWindow()
    mocks.isAllowedPartition.mockReturnValue(true)
    const params = { src: 'https://example.com', preload: 'attacker.js' }
    const preferences: Record<string, unknown> = {
      partition: 'persist:orca-browser',
      preload: 'attacker.js',
      preloadURL: 'attacker.js',
      sandbox: false
    }

    handlers['will-attach-webview']?.(
      { preventDefault: vi.fn() } as never,
      preferences as never,
      params as never
    )

    expect(params).not.toHaveProperty('preload')
    expect(preferences).toMatchObject({
      ...ORCA_BROWSER_GUEST_WEB_PREFERENCES,
      partition: 'persist:orca-browser',
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true
    })
    expect(preferences).not.toHaveProperty('preloadURL')
    expect(String(preferences.preload)).toMatch(/browser-window-close-preload\.js$/)
  })
})

describe('orca-preview scheme admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    revokeAllDocPreviewGrants()
  })

  it('admits a preview URL only on the preview partition and only with a live grant', () => {
    // Install first, as the window does: installation itself clears the registry.
    const { handlers } = installOnFakeWindow()
    const grant = mintPreviewGrant()
    mocks.isAllowedPartition.mockReturnValue(false)
    const preventDefault = vi.fn()
    const preferences: Record<string, unknown> = {
      partition: DOC_PREVIEW_PARTITION,
      preload: 'attacker.js',
      sandbox: false
    }

    handlers['will-attach-webview']?.(
      { preventDefault } as never,
      preferences as never,
      { src: buildDocPreviewUrl(grant.id, 'index.html'), preload: 'attacker.js' } as never
    )

    expect(preventDefault).not.toHaveBeenCalled()
    expect(preferences).toMatchObject({
      partition: DOC_PREVIEW_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    })
    expect(preferences).not.toHaveProperty('preloadURL')
  })

  // Why both directions: the preview preload is the only script that can turn a press into a
  // browser tab, so a browsing guest must never receive it — and a preview must never receive
  // anything else, least of all a value the renderer supplied.
  it('pins the preview preload onto a preview attach, replacing whatever the renderer asked for', () => {
    const { handlers } = installOnFakeWindow()
    const grant = mintPreviewGrant()
    mocks.isAllowedPartition.mockReturnValue(false)
    const params = { src: buildDocPreviewUrl(grant.id, 'index.html'), preload: 'attacker.js' }
    const preferences: Record<string, unknown> = {
      partition: DOC_PREVIEW_PARTITION,
      preload: 'attacker.js'
    }

    handlers['will-attach-webview']?.(
      { preventDefault: vi.fn() } as never,
      preferences as never,
      params as never
    )

    expect(params).not.toHaveProperty('preload')
    expect(String(preferences.preload)).toMatch(/doc-preview-link-preload\.js$/)
  })

  it('keeps the preview preload off a browsing attach', () => {
    const { handlers } = installOnFakeWindow()
    mocks.isAllowedPartition.mockReturnValue(true)
    const preferences: Record<string, unknown> = { partition: 'persist:orca-browser' }

    handlers['will-attach-webview']?.(
      { preventDefault: vi.fn() } as never,
      preferences as never,
      { src: 'https://example.com' } as never
    )

    expect(String(preferences.preload)).toMatch(/browser-window-close-preload\.js$/)
  })

  it('denies a preview URL whose grant is unknown or revoked', () => {
    const { handlers } = installOnFakeWindow()
    mocks.isAllowedPartition.mockReturnValue(false)
    const preventDefault = vi.fn()

    handlers['will-attach-webview']?.(
      { preventDefault } as never,
      { partition: DOC_PREVIEW_PARTITION } as never,
      { src: `orca-preview://${'0'.repeat(32)}/index.html` } as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('denies a preview URL smuggled onto a browsing partition', () => {
    const { handlers } = installOnFakeWindow()
    const grant = mintPreviewGrant()
    // Even an allowlisted browsing partition must not load the preview scheme.
    mocks.isAllowedPartition.mockReturnValue(true)
    const preventDefault = vi.fn()

    handlers['will-attach-webview']?.(
      { preventDefault } as never,
      { partition: 'persist:orca-browser' } as never,
      { src: buildDocPreviewUrl(grant.id, 'index.html') } as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('denies a web URL on the preview partition', () => {
    const { handlers } = installOnFakeWindow()
    mocks.isAllowedPartition.mockReturnValue(false)
    const preventDefault = vi.fn()

    handlers['will-attach-webview']?.(
      { preventDefault } as never,
      { partition: DOC_PREVIEW_PARTITION } as never,
      { src: 'https://example.com' } as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  // Why the host is asserted and not just the profile: it is the renderer that minted the grant,
  // and it is the only sink a link the reader presses can be reported to. A preview attached
  // against another window's contents would report its clicks to a reader who is not there.
  it('attaches a preview guest under the workspace-doc profile, hosted by this window', () => {
    const { handlers, webContents } = installOnFakeWindow()

    handlers['did-attach-webview']?.({} as never, { session: 'doc-preview-session' } as never)

    expect(mocks.attachGuestPolicies).toHaveBeenCalledWith(
      { session: 'doc-preview-session' },
      null,
      {
        profile: 'workspace-doc',
        host: webContents
      }
    )
    expect(mocks.attachRouteGuest).not.toHaveBeenCalled()
  })

  it('keeps browser guests on the browsing profile and its route registration', () => {
    const { handlers } = installOnFakeWindow()

    handlers['did-attach-webview']?.({} as never, { session: 'browser-session' } as never)

    expect(mocks.attachGuestPolicies).toHaveBeenCalledOnce()
    expect(mocks.attachGuestPolicies.mock.calls[0]?.[2]).toBeUndefined()
    expect(mocks.attachRouteGuest).toHaveBeenCalledOnce()
  })

  // Why: every live preview belongs to this window, so its teardown is the one moment no grant can
  // still have a reader — and the failure sink must stop pointing at dead WebContents.
  it('drops the failure sink and every grant when the window contents are destroyed', () => {
    const { handlers } = installOnFakeWindow()
    const grant = mintPreviewGrant()
    const send = vi.fn()
    setDocPreviewFailureSink({ send })
    expect(getDocPreviewGrant(grant.id)).not.toBeNull()

    handlers['destroyed']?.()
    publishDocPreviewFailure({
      grantId: grant.id,
      relativePath: 'index.html',
      reason: 'unreadable'
    })

    expect(getDocPreviewGrant(grant.id)).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  // Why: the renderer is the only side that remembers which preview owns which grant, so a grant
  // that outlives its renderer is a read authority nobody can release.
  it('clears grants a previous renderer left behind when the window is created', () => {
    const stranded = mintPreviewGrant()

    installOnFakeWindow()

    expect(getDocPreviewGrant(stranded.id)).toBeNull()
  })

  it('clears grants the renderer forgot across a reload', () => {
    const { handlers } = installOnFakeWindow()
    const grant = mintPreviewGrant()

    handlers['did-start-navigation']?.({ isMainFrame: true, isSameDocument: false } as never)

    expect(getDocPreviewGrant(grant.id)).toBeNull()
  })

  it('keeps grants across an in-document or subframe navigation, which keeps the renderer', () => {
    const { handlers } = installOnFakeWindow()
    const grant = mintPreviewGrant()

    handlers['did-start-navigation']?.({ isMainFrame: true, isSameDocument: true } as never)
    handlers['did-start-navigation']?.({ isMainFrame: false, isSameDocument: false } as never)

    expect(getDocPreviewGrant(grant.id)).not.toBeNull()
  })
})
