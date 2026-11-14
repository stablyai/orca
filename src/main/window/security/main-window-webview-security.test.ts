import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMainWindowWebviewSecurity } from './main-window-webview-security'

const state = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { app: new EventEmitter(), session: {}, ready: Promise.resolve() }
})
vi.mock('electron', () => ({ app: state.app, session: { fromPartition: () => state.session } }))
vi.mock('../../browser/guest-lifecycle/manager/browser-manager', () => ({
  browserManager: { attachGuestPolicies: vi.fn() }
}))
vi.mock('../../browser/sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    isAllowedPartition: () => true,
    listProfiles: () => [{ id: 'p', partition: 'persist:p' }],
    getEnabledExtensionIds: () => ['abcdefghijklmnopabcdefghijklmnop']
  }
}))
vi.mock('../../browser/routing/local-host-partitions/local-ssh-browser-partitions', () => ({
  isLocalSshBrowserPartition: () => false,
  enforceLocalSshWebRtcPolicyForGuest: vi.fn()
}))
vi.mock('../../browser/routing/sessions/browser-route-session-runtime', () => ({
  browserRouteSessionRegistry: { isAllowedPartition: () => false },
  browserRouteWebContentsRegistry: { attachGuest: vi.fn() }
}))
vi.mock('../../browser/document-preview/doc-preview-failure-notice', () => ({
  setDocPreviewFailureSink: vi.fn()
}))
vi.mock('../../browser/document-preview/doc-preview-grant-registry', () => ({
  getDocPreviewGrant: () => null,
  revokeAllDocPreviewGrants: vi.fn()
}))
vi.mock('../../browser/document-preview/doc-preview-protocol', () => ({
  isDocPreviewSession: () => false
}))
vi.mock('./host-frame-navigation-guard', () => ({ registerHostFrameNavigationGuard: vi.fn() }))
vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: vi.fn()
}))
vi.mock('../../browser/guest-lifecycle/prompts/browser-javascript-dialogs', () => ({
  installBrowserJavaScriptDialogs: vi.fn()
}))
vi.mock('../../host/native-chat-visual-guest-theme', () => ({
  installNativeChatVisualGuestTheme: vi.fn()
}))
vi.mock('../../plugins/panels/guest-isolation/plugin-frame-guest-registry', () => ({
  isPluginFramePartition: () => false,
  admitPluginFrameAttach: () => false,
  attachPluginFrameGuest: () => false,
  PLUGIN_FRAME_GUEST_RENDERER_ARGUMENTS: []
}))
vi.mock('../../browser-passwords/browser-password-guest-service', () => ({
  attachBrowserPasswordGuest: vi.fn()
}))
vi.mock('../../browser/extensions/profile-sessions/browser-extension-profile-demand', () => ({
  onBrowserExtensionPageReadiness: (_guest: unknown, listener: (ready: Promise<void>) => void) => {
    listener(state.ready)
    return () => {}
  }
}))

function host() {
  const contents = Object.assign(new EventEmitter(), { setWebRTCIPHandlingPolicy: vi.fn() })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the host event/policy surface used by this installer.
  installMainWindowWebviewSecurity({ webContents: contents } as unknown as Electron.BrowserWindow)
  return contents
}
function guest(owner: EventEmitter, overrides = {}) {
  return Object.assign(new EventEmitter(), {
    session: state.session,
    hostWebContents: owner,
    getType: () => 'webview',
    isDestroyed: () => false,
    getLastWebPreferences: () => ({ sandbox: true }),
    loadURL: vi.fn(async () => {}),
    ...overrides
  })
}
function stage(owner: EventEmitter, src: string, options = {}) {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    }
  }
  const params = { src, ...options }
  owner.emit('will-attach-webview', event, { partition: 'persist:p' }, params)
  expect(params.src).toBe('')
  return event
}
function created(contents: ReturnType<typeof guest>) {
  state.app.emit('web-contents-created', {}, contents)
}
function attach(owner: EventEmitter, contents: ReturnType<typeof guest>) {
  owner.emit('did-attach-webview', {}, contents)
}
afterEach(() => {
  state.app.removeAllListeners()
  state.ready = Promise.resolve()
})

describe('profile guest initial navigation', () => {
  it('keeps restored extension and HTTP intents/options until combined readiness, without preference markers', async () => {
    let release = () => {}
    state.ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const owner = host()
    const restored = guest(owner)
    const web = guest(owner)
    stage(owner, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html')
    created(restored)
    stage(owner, 'https://example.com/first', {
      httpreferrer: 'https://referrer.example/',
      useragent: 'fixture-agent'
    })
    created(web)
    attach(owner, web)
    attach(owner, restored)
    expect(web.loadURL).not.toHaveBeenCalled()
    expect(restored.loadURL).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() =>
      expect(restored.loadURL).toHaveBeenCalledExactlyOnceWith(
        'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html',
        {}
      )
    )
    expect(web.loadURL).toHaveBeenCalledExactlyOnceWith('https://example.com/first', {
      httpReferrer: 'https://referrer.example/',
      userAgent: 'fixture-agent'
    })
    attach(owner, restored)
    await Promise.resolve()
    expect(restored.loadURL).toHaveBeenCalledTimes(1)
  })

  it('binds nested same-session construction by object and ignores unrelated, wrong-identity and canceled guests', async () => {
    const owner = host()
    const outer = guest(owner)
    const inner = guest(owner)
    const helper = guest(owner, { getType: () => 'window' })
    const wrongHost = guest(new EventEmitter())
    const wrongSession = guest(owner, { session: {} })
    stage(owner, 'https://outer.example/')
    stage(owner, 'https://inner.example/')
    created(helper)
    created(wrongHost)
    created(wrongSession)
    const canceled = stage(owner, 'https://canceled.example/')
    canceled.preventDefault()
    created(inner)
    created(outer)
    attach(owner, outer)
    attach(owner, inner)
    attach(owner, helper)
    attach(owner, wrongHost)
    attach(owner, wrongSession)
    await vi.waitFor(() =>
      expect(inner.loadURL).toHaveBeenCalledExactlyOnceWith('https://inner.example/', {})
    )
    expect(outer.loadURL).toHaveBeenCalledExactlyOnceWith('https://outer.example/', {})
    expect(helper.loadURL).not.toHaveBeenCalled()
    expect(wrongHost.loadURL).not.toHaveBeenCalled()
    expect(wrongSession.loadURL).not.toHaveBeenCalled()
  })

  it('retires pre-attach destruction, supersession and host shutdown without leaking to a successor', async () => {
    const owner = host()
    const destroyed = guest(owner)
    const superseded = guest(owner)
    const orphan = guest(owner)
    stage(owner, 'https://destroyed.example/')
    created(destroyed)
    destroyed.emit('destroyed')
    stage(owner, 'https://superseded.example/')
    created(superseded)
    superseded.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    attach(owner, destroyed)
    attach(owner, superseded)
    stage(owner, 'https://construction-failed.example/')
    await Promise.resolve()
    stage(owner, 'https://successor.example/')
    const successor = guest(owner)
    created(successor)
    attach(owner, successor)
    await vi.waitFor(() =>
      expect(successor.loadURL).toHaveBeenCalledExactlyOnceWith('https://successor.example/', {})
    )
    stage(owner, 'https://orphan.example/')
    created(orphan)
    owner.emit('destroyed')
    attach(owner, orphan)
    await Promise.resolve()
    expect(destroyed.loadURL).not.toHaveBeenCalled()
    expect(superseded.loadURL).not.toHaveBeenCalled()
    expect(orphan.loadURL).not.toHaveBeenCalled()
  })
})
