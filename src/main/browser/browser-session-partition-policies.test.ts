import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'

const mocks = vi.hoisted(() => ({
  handleGuestWillDownload: vi.fn(),
  noticeDocPreviewDownloadBlocked: vi.fn(),
  clearBrowserWebAuthnAccessHandlers: vi.fn(),
  installBrowserWebAuthnAccessHandlers: vi.fn(),
  isRemoteCliDrivenGuest: vi.fn((_webContentsId?: number) => false),
  requestExternalAppLaunch: vi.fn(),
  notifyPermissionDenied: vi.fn(),
  resolvePagePromptTarget: vi.fn()
}))

type WillDownloadListener = (
  event: { preventDefault: () => void },
  item: { id: string },
  webContents: { id: number }
) => void

type FakeSession = {
  listeners: WillDownloadListener[]
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  getUserAgent: () => string
  setUserAgent: ReturnType<typeof vi.fn>
  setPermissionRequestHandler: ReturnType<typeof vi.fn>
  setPermissionCheckHandler: ReturnType<typeof vi.fn>
  setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>
}

const sessionsByPartition = new Map<string, FakeSession>()

function fakeSession(): FakeSession {
  const listeners: WillDownloadListener[] = []
  return {
    listeners,
    on: vi.fn((event: string, listener: WillDownloadListener) => {
      if (event === 'will-download') {
        listeners.push(listener)
      }
    }),
    removeListener: vi.fn((event: string, listener: WillDownloadListener) => {
      if (event !== 'will-download') {
        return
      }
      const index = listeners.indexOf(listener)
      if (index !== -1) {
        listeners.splice(index, 1)
      }
    }),
    getUserAgent: () => 'Mozilla/5.0 Orca',
    setUserAgent: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn()
  }
}

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      const existing = sessionsByPartition.get(partition)
      if (existing) {
        return existing
      }
      const created = fakeSession()
      sessionsByPartition.set(partition, created)
      return created
    }
  }
}))
vi.mock('./desktop-browser-bridge/remote-cli-driven-workspaces', () => ({
  isRemoteCliDrivenGuest: mocks.isRemoteCliDrivenGuest
}))
vi.mock('./browser-manager', () => ({
  browserManager: {
    handleGuestWillDownload: mocks.handleGuestWillDownload,
    installCertificateRequestGuard: vi.fn(),
    removeCertificateRequestGuard: vi.fn(),
    notifyPermissionDenied: mocks.notifyPermissionDenied,
    requestExternalAppLaunch: mocks.requestExternalAppLaunch,
    resolvePagePromptTarget: mocks.resolvePagePromptTarget
  }
}))
vi.mock('./doc-preview-download-block-notice', () => ({
  noticeDocPreviewDownloadBlocked: mocks.noticeDocPreviewDownloadBlocked
}))
vi.mock('./browser-media-access', () => ({
  hasSystemMediaAccess: () => false,
  requestSystemMediaAccess: async () => false
}))
vi.mock('./browser-session-ua', () => ({
  installBrowserSessionUserAgentPolicy: vi.fn(() => vi.fn())
}))
vi.mock('./browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({ mode: 'clean', userAgent: 'Mozilla/5.0 Orca' })
}))
vi.mock('./browser-webauthn-access', () => ({
  allowsBrowserWebAuthnPermission: () => false,
  clearBrowserWebAuthnAccessHandlers: mocks.clearBrowserWebAuthnAccessHandlers,
  installBrowserWebAuthnAccessHandlers: mocks.installBrowserWebAuthnAccessHandlers
}))

type FakeTab = {
  id: number
  getURL: () => string
  mainFrame: { framesInSubtree: { url: string; origin: string }[] }
}

type PartitionPolicyInstaller = (
  profile: BrowserSessionProfile,
  options?: {
    downloads?: 'route' | 'deny'
    permissions?: 'browser' | 'deny'
    sitePermissions?: 'saved' | 'session'
  }
) => void

// Reset module state per test so partition-install memoization cannot reuse earlier listeners.
async function loadInstaller(): Promise<PartitionPolicyInstaller> {
  const module = await import('./browser-session-partition-policies')
  return module.installBrowserSessionPartitionPolicies
}

function profileFor(partition: string): BrowserSessionProfile {
  return {
    id: partition,
    scope: 'isolated',
    partition,
    label: partition,
    source: null
  }
}

function fireWillDownload(partition: string): { cancelled: boolean } {
  const sess = sessionsByPartition.get(partition)
  if (!sess || sess.listeners.length !== 1) {
    throw new Error(`expected exactly one will-download listener on ${partition}`)
  }
  let cancelled = false
  sess.listeners[0]({ preventDefault: () => (cancelled = true) }, { id: 'item-1' }, { id: 42 })
  return { cancelled }
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionsByPartition.clear()
  vi.resetModules()
})

describe('partition download policy', () => {
  it('routes a download on a partition that did not ask for the deny', async () => {
    const install = await loadInstaller()
    install(profileFor('persist:browsing-1'))

    expect(fireWillDownload('persist:browsing-1').cancelled).toBe(false)
    expect(mocks.handleGuestWillDownload).toHaveBeenCalledWith(
      expect.objectContaining({ guestWebContentsId: 42 })
    )
  })

  it('cancels a download on a partition that asked for the deny, routing nothing', async () => {
    const install = await loadInstaller()
    install(profileFor('orca-doc-preview'), { downloads: 'deny' })

    expect(fireWillDownload('orca-doc-preview').cancelled).toBe(true)
    expect(mocks.handleGuestWillDownload).not.toHaveBeenCalled()
  })

  it('tells the reader about the refusal, and only on the partition that refused', async () => {
    const install = await loadInstaller()
    install(profileFor('orca-doc-preview'), { downloads: 'deny' })
    install(profileFor('persist:browsing-1'))

    fireWillDownload('persist:browsing-1')
    expect(mocks.noticeDocPreviewDownloadBlocked).not.toHaveBeenCalled()

    fireWillDownload('orca-doc-preview')
    expect(mocks.noticeDocPreviewDownloadBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 })
    )
  })

  it('keeps each partition on its own decision', async () => {
    const install = await loadInstaller()
    install(profileFor('orca-doc-preview'), { downloads: 'deny' })
    install(profileFor('persist:browsing-1'))

    expect(fireWillDownload('orca-doc-preview').cancelled).toBe(true)
    expect(fireWillDownload('persist:browsing-1').cancelled).toBe(false)
    expect(mocks.handleGuestWillDownload).toHaveBeenCalledTimes(1)
  })
})

describe('partition permission policy', () => {
  it('denies clipboard reads only to pages an SSH host has driven (#29145)', async () => {
    mocks.isRemoteCliDrivenGuest.mockImplementation((id?: number) => id === 7)
    const install = await loadInstaller()
    const store = await import('./browser-site-permission-store')
    store.configureBrowserSitePermissionStore(mkdtempSync(join(tmpdir(), 'orca-site-permissions-')))
    store.setBrowserSitePermissionDecisions(
      'persist:browsing-2',
      'https://a.test',
      ['clipboard'],
      'allow'
    )
    install(profileFor('persist:browsing-2'))
    const sess = sessionsByPartition.get('persist:browsing-2')
    if (!sess) {
      throw new Error('Expected the browsing session')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer registered exactly this handler on the fake session.
    const requestHandler = sess.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      webContents: { id: number; getURL: () => string },
      permission: string,
      callback: (allowed: boolean) => void,
      details: Partial<Electron.PermissionRequest>
    ) => void
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer registered exactly this handler on the fake session.
    const checkHandler = sess.setPermissionCheckHandler.mock.calls[0]?.[0] as (
      webContents: { id: number; getURL: () => string },
      permission: string,
      requestingOrigin: string
    ) => boolean
    const guest = (id: number) => ({ id, getURL: () => 'https://a.test/' })

    const decisions = new Map<string, boolean>()
    const record = (key: string) => (allowed: boolean) => decisions.set(key, allowed)
    requestHandler(guest(7), 'clipboard-read', record('driven read'), {})
    requestHandler(guest(8), 'clipboard-read', record('read'), {})
    requestHandler(guest(7), 'clipboard-sanitized-write', record('driven write'), {})

    await vi.waitFor(() => expect(decisions.size).toBe(3))
    expect(Object.fromEntries(decisions)).toEqual({
      'driven read': false,
      read: true,
      'driven write': true
    })
    expect(checkHandler(guest(7), 'clipboard-read', 'https://a.test')).toBe(false)
    expect(checkHandler(guest(8), 'clipboard-read', 'https://a.test')).toBe(true)
  })

  it("answers a notification from a frame with an inherited origin as the frame's real site", async () => {
    const install = await loadInstaller()
    const store = await import('./browser-site-permission-store')
    store.configureBrowserSitePermissionStore(mkdtempSync(join(tmpdir(), 'orca-site-permissions-')))
    store.setBrowserSitePermissionDecisions(
      'persist:browsing-frames',
      'https://a.test',
      ['notifications'],
      'allow'
    )
    install(profileFor('persist:browsing-frames'))
    const sess = sessionsByPartition.get('persist:browsing-frames')
    if (!sess) {
      throw new Error('Expected the browsing session')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer registered exactly this handler on the fake session.
    const requestHandler = sess.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      webContents: FakeTab,
      permission: string,
      callback: (allowed: boolean) => void,
      details: Partial<Electron.PermissionRequest>
    ) => void
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer registered exactly this handler on the fake session.
    const checkHandler = sess.setPermissionCheckHandler.mock.calls[0]?.[0] as (
      webContents: FakeTab,
      permission: string,
      requestingOrigin: string,
      details: Partial<Electron.PermissionCheckHandlerHandlerDetails>
    ) => boolean
    const tab = {
      id: 12,
      getURL: () => 'https://a.test/',
      mainFrame: {
        framesInSubtree: [
          { url: 'https://a.test/', origin: 'https://a.test' },
          { url: 'about:srcdoc', origin: 'https://a.test' },
          { url: 'https://b.test/widget', origin: 'https://b.test' },
          { url: 'about:blank', origin: 'https://b.test' }
        ]
      }
    }
    const request = (requestingUrl: string): Promise<boolean> =>
      new Promise((resolve) =>
        requestHandler(tab, 'notifications', resolve, { requestingUrl, isMainFrame: false })
      )

    // Permission checks carry inherited origins; requests may carry opaque frame URLs.
    expect(
      checkHandler(tab, 'notifications', 'https://a.test', {
        requestingUrl: 'about:srcdoc',
        isMainFrame: false
      })
    ).toBe(true)
    await expect(request('about:srcdoc')).resolves.toBe(true)
    await expect(request('about:blank')).resolves.toBe(false)
    tab.mainFrame.framesInSubtree.push({ url: 'about:blank', origin: 'https://a.test' })
    // Ambiguous blank-frame origins must be refused.
    await expect(request('about:blank')).resolves.toBe(false)
  })

  it('asks when a page checks local network access, since Electron never requests it', async () => {
    const install = await loadInstaller()
    const store = await import('./browser-site-permission-store')
    store.configureBrowserSitePermissionStore(mkdtempSync(join(tmpdir(), 'orca-site-permissions-')))
    const { respondToBrowserPagePrompt } = await import('./browser-page-prompts')
    const send = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prompts only read id, isDestroyed, send and subscribe to the window's lifecycle events.
    const renderer = {
      id: 10,
      isDestroyed: () => false,
      send,
      on: vi.fn(),
      off: vi.fn()
    } as unknown as Electron.WebContents
    mocks.resolvePagePromptTarget.mockReturnValue({ browserPageId: 'page-1', renderer })
    install(profileFor('persist:browsing-lna'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer registered exactly this handler on the fake session.
    const checkHandler = sessionsByPartition.get('persist:browsing-lna')?.setPermissionCheckHandler
      .mock.calls[0]?.[0] as (
      webContents: EventEmitter,
      permission: string,
      origin: string
    ) => boolean
    const tab = (url: string): EventEmitter =>
      Object.assign(new EventEmitter(), { id: 20, isDestroyed: () => false, getURL: () => url })
    const prompts = () =>
      send.mock.calls.filter(([channel]) => channel === 'browser:page-prompt-requested')
    const signIn = tab('https://login.example.com/signin')

    // Chromium 150 asks loopback-network for 127.0.0.1; older pages query the legacy name.
    expect(checkHandler(signIn, 'loopback-network', 'https://login.example.com')).toBe(false)
    expect(checkHandler(signIn, 'local-network-access', 'https://login.example.com')).toBe(false)
    expect(prompts()).toMatchObject([
      [
        'browser:page-prompt-requested',
        { details: { origin: 'https://login.example.com', permissions: ['local-network'] } }
      ]
    ])
    await respondToBrowserPagePrompt(renderer, {
      requestId: prompts()[0][1].requestId,
      answer: 'allow'
    })
    expect(checkHandler(signIn, 'loopback-network', 'https://login.example.com')).toBe(true)

    // Chrome never gates loopback pages, so localhost dev servers neither ask nor read denied.
    expect(
      checkHandler(tab('http://localhost:5173/'), 'loopback-network', 'http://localhost:5173')
    ).toBe(true)
    expect(prompts()).toHaveLength(1)
  })

  it("keeps a paired server's pages off this computer's saved answers for the same profile id", async () => {
    const install = await loadInstaller()
    const store = await import('./browser-site-permission-store')
    store.configureBrowserSitePermissionStore(mkdtempSync(join(tmpdir(), 'orca-site-permissions-')))
    store.setBrowserSitePermissionDecisions('default', 'https://a.test', ['clipboard'], 'allow')
    const desktop = { ...profileFor('persist:desktop-default'), id: 'default' }
    const paired = { ...profileFor('persist:paired-default'), id: 'default' }
    install(desktop)
    install(paired, { sitePermissions: 'session' })
    const check = (partition: string): boolean => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer registered exactly this handler on the fake session.
      const handler = sessionsByPartition.get(partition)?.setPermissionCheckHandler.mock
        .calls[0]?.[0] as (
        webContents: { id: number; getURL: () => string },
        permission: string,
        requestingOrigin: string
      ) => boolean
      return handler({ id: 1, getURL: () => 'https://a.test/' }, 'clipboard-read', 'https://a.test')
    }

    expect(check('persist:desktop-default')).toBe(true)
    expect(check('persist:paired-default')).toBe(false)
  })

  it("keeps a paired partition's answers after its last page closes and it reopens", async () => {
    const install = await loadInstaller()
    const policies = await import('./browser-session-partition-policies')
    const prompts = await import('./browser-site-permission-prompt')
    const paired = profileFor('persist:paired-work')
    install(paired, { sitePermissions: 'session' })
    prompts
      .sessionBrowserSitePermissions('persist:paired-work')
      .set('https://a.test', ['clipboard'], 'allow')
    const sess = sessionsByPartition.get('persist:paired-work')
    if (!sess) {
      throw new Error('Expected the paired session')
    }
    const check = (): boolean => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer registered this handler on the fake session.
      const handler = sess.setPermissionCheckHandler.mock.calls.at(-1)?.[0] as (
        webContents: { id: number; getURL: () => string },
        permission: string,
        requestingOrigin: string
      ) => boolean
      return handler({ id: 1, getURL: () => 'https://a.test/' }, 'clipboard-read', 'https://a.test')
    }
    expect(check()).toBe(true)

    // Closing the last page clears the partition's policies; the next page installs them again.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the clear path only touches the fake session's handler setters and listeners.
    const electronSession = sess as unknown as Electron.Session
    policies.clearBrowserSessionPartitionPolicies('persist:paired-work', electronSession)
    install(paired, { sitePermissions: 'session' })
    expect(check()).toBe(true)
  })

  it('gives browsing pages File System Access but keeps it from pages another machine can script', async () => {
    const install = await loadInstaller()
    const { installBrowserRoutePartitionPolicies } =
      await import('./browser-session-route-policies')
    const routed = `persist:orca-browser-v1-${'a'.repeat(64)}`
    install(profileFor('persist:browsing-5'))
    void installBrowserRoutePartitionPolicies(profileFor('persist:browsing-5'), routed)
    const decide = (partition: string) => {
      const sess = sessionsByPartition.get(partition)
      if (!sess) {
        throw new Error(`Expected the session for ${partition}`)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer registered exactly this handler on the fake session.
      const requestHandler = sess.setPermissionRequestHandler.mock.calls[0]?.[0] as (
        webContents: { id: number; getURL: () => string },
        permission: string,
        callback: (allowed: boolean) => void,
        details: Partial<Electron.FilesystemPermissionRequest>
      ) => void
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer registered exactly this handler on the fake session.
      const checkHandler = sess.setPermissionCheckHandler.mock.calls[0]?.[0] as (
        webContents: null,
        permission: string,
        requestingOrigin: string,
        details: Partial<Electron.PermissionCheckHandlerHandlerDetails>
      ) => boolean
      let requested: boolean | null = null
      requestHandler(
        { id: 11, getURL: () => 'https://app.test/' },
        'fileSystem',
        (allowed) => (requested = allowed),
        { filePath: '/Users/me/project', isDirectory: true, fileAccessType: 'writable' }
      )
      const checked = checkHandler(null, 'fileSystem', 'https://app.test', {
        filePath: '/Users/me/notes.txt',
        isDirectory: false,
        fileAccessType: 'writable'
      })
      return { requested, checked }
    }

    expect(decide('persist:browsing-5')).toEqual({ requested: true, checked: true })
    expect(mocks.notifyPermissionDenied).not.toHaveBeenCalled()
    expect(decide(routed)).toEqual({ requested: false, checked: false })
    expect(mocks.notifyPermissionDenied).toHaveBeenCalledWith(
      expect.objectContaining({ guestWebContentsId: 11, permission: 'fileSystem' })
    )
  })

  it('refuses a blocklisted system folder at once instead of leaving the page waiting', async () => {
    const install = await loadInstaller()
    install(profileFor('persist:browsing-6'))
    install(profileFor('orca-doc-preview'), { permissions: 'deny' })
    const answer = (partition: string) => {
      const sess = sessionsByPartition.get(partition)
      const listener = sess?.on.mock.calls.find(
        ([event]) => event === 'file-system-access-restricted'
      )?.[1]
      const actions: string[] = []
      listener?.(
        {},
        {
          origin: 'https://app.test',
          isDirectory: true,
          path: '/Users/me',
          webContents: { id: 12 }
        },
        (action: string) => actions.push(action)
      )
      return actions
    }

    expect(answer('orca-doc-preview')).toEqual(['deny'])
    expect(mocks.notifyPermissionDenied).not.toHaveBeenCalled()
    expect(answer('persist:browsing-6')).toEqual(['deny'])
    expect(mocks.notifyPermissionDenied).toHaveBeenCalledWith({
      guestWebContentsId: 12,
      permission: 'fileSystem',
      rawUrl: 'https://app.test'
    })
  })

  it('hands a link to another app to the open-app prompt instead of denying it', async () => {
    const install = await loadInstaller()
    install(profileFor('persist:browsing-4'))
    const sess = sessionsByPartition.get('persist:browsing-4')
    if (!sess) {
      throw new Error('Expected the browsing session')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer registered exactly this handler on the fake session.
    const requestHandler = sess.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      webContents: { id: number; getURL: () => string },
      permission: string,
      callback: (allowed: boolean) => void,
      details: { externalURL?: string; requestingUrl?: string }
    ) => void
    const guest = { id: 9, getURL: () => 'https://acme.okta.com/signin' }
    const details = {
      externalURL: 'com-okta-authenticator:/deviceChallenge',
      requestingUrl: 'https://login.acme.okta.com/frame'
    }
    const decisions: boolean[] = []

    mocks.requestExternalAppLaunch.mockReturnValueOnce(true)
    requestHandler(guest, 'openExternal', (allowed) => decisions.push(allowed), details)
    const [launchGuest, launchUrl, requestingUrl] = mocks.requestExternalAppLaunch.mock.calls[0]
    expect([launchGuest, launchUrl]).toEqual([guest, 'com-okta-authenticator:/deviceChallenge'])
    expect(requestingUrl()).toBe('https://login.acme.okta.com/frame')
    expect(mocks.notifyPermissionDenied).not.toHaveBeenCalled()

    mocks.requestExternalAppLaunch.mockReturnValueOnce(false)
    requestHandler(guest, 'openExternal', (allowed) => decisions.push(allowed), details)
    expect(mocks.notifyPermissionDenied).toHaveBeenCalledWith(
      expect.objectContaining({ guestWebContentsId: 9, permission: 'openExternal' })
    )
    // Orca launches approved apps itself, so Chromium's launch remains denied.
    expect(decisions).toEqual([false, false])
  })

  it('cancels a download from a page an SSH host drives (#29145)', async () => {
    mocks.isRemoteCliDrivenGuest.mockImplementation((id?: number) => id === 42)
    const install = await loadInstaller()
    install(profileFor('persist:browsing-3'))

    expect(fireWillDownload('persist:browsing-3')).toEqual({ cancelled: true })
    expect(mocks.handleGuestWillDownload).not.toHaveBeenCalled()
  })

  it('denies every request and check on a strict partition without WebAuthn handlers', async () => {
    const install = await loadInstaller()
    install(profileFor('orca-doc-preview'), { permissions: 'deny' })
    const sess = sessionsByPartition.get('orca-doc-preview')
    if (!sess) {
      throw new Error('Expected the preview session')
    }
    const requestHandler = sess.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      webContents: Electron.WebContents,
      permission: string,
      callback: (allowed: boolean) => void
    ) => void
    const checkHandler = sess.setPermissionCheckHandler.mock.calls[0]?.[0] as (
      webContents: Electron.WebContents,
      permission: string
    ) => boolean
    const displayMediaHandler = sess.setDisplayMediaRequestHandler.mock.calls[0]?.[0] as (
      request: Electron.DisplayMediaRequestHandlerHandlerRequest,
      callback: (streams: { video?: Electron.WebFrameMain; audio?: 'loopback' }) => void
    ) => void

    for (const permission of ['media', 'clipboard-read', 'notifications', 'fullscreen']) {
      let decision: boolean | null = null
      requestHandler({} as Electron.WebContents, permission, (allowed) => (decision = allowed))
      expect(decision).toBe(false)
      expect(checkHandler({} as Electron.WebContents, permission)).toBe(false)
    }
    expect(mocks.installBrowserWebAuthnAccessHandlers).not.toHaveBeenCalled()
    expect(mocks.clearBrowserWebAuthnAccessHandlers).toHaveBeenCalledWith(sess)
    let displayMediaDecision: { video?: Electron.WebFrameMain; audio?: 'loopback' } | null = null
    displayMediaHandler({} as Electron.DisplayMediaRequestHandlerHandlerRequest, (decision) => {
      displayMediaDecision = decision
    })
    expect(displayMediaDecision).toEqual({ video: undefined, audio: undefined })
  })
})
