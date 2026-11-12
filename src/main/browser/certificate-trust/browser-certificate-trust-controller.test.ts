import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserCertificateTrustController } from './browser-certificate-trust-controller'
import { resetSessionProxyApplicationForTests } from '../../network/proxy-settings'

const FIRST_CERTIFICATE = certificate('first certificate')
let beforeRequestListener:
  | ((
      details: Electron.OnBeforeRequestListenerDetails,
      callback: (response: Electron.CallbackResponse) => void
    ) => void)
  | null = null
const browserSession = {
  resolveProxy: vi.fn(async () => 'DIRECT'),
  setProxy: vi.fn(async () => {}),
  closeAllConnections: vi.fn(async () => {}),
  webRequest: {
    onBeforeRequest: vi.fn(
      (
        listener:
          | ((
              details: Electron.OnBeforeRequestListenerDetails,
              callback: (response: Electron.CallbackResponse) => void
            ) => void)
          | null
      ) => {
        beforeRequestListener = listener
      }
    )
  }
} as unknown as Electron.Session

function certificate(contents: string): Electron.Certificate {
  return {
    data: `-----BEGIN CERTIFICATE-----\n${Buffer.from(contents).toString('base64')}\n-----END CERTIFICATE-----`
  } as Electron.Certificate
}

function createGuest(id: number): Electron.WebContents {
  return {
    id,
    session: browserSession,
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(() => Promise.resolve())
  } as unknown as Electron.WebContents
}

function beforeRequest(args: {
  url?: string
  webContentsId?: number
  resourceType?: Electron.OnBeforeRequestListenerDetails['resourceType']
}) {
  const callback = vi.fn()
  beforeRequestListener?.(
    {
      id: 1,
      url: args.url ?? 'https://localhost:3443/app',
      method: 'GET',
      webContentsId: args.webContentsId,
      resourceType: args.resourceType ?? 'mainFrame',
      referrer: '',
      timestamp: 1,
      uploadData: []
    },
    callback
  )
  return callback
}

function certificateEvent(args: {
  controller: BrowserCertificateTrustController
  guest: Electron.WebContents
  url?: string
  error?: string
  certificate?: Electron.Certificate
  isMainFrame?: boolean
}) {
  const preventDefault = vi.fn()
  const callback = vi.fn()
  args.controller.handleCertificateError({
    event: { preventDefault },
    webContents: args.guest,
    url: args.url ?? 'https://localhost:3443/app',
    error: args.error ?? 'net::ERR_CERT_AUTHORITY_INVALID',
    certificate: args.certificate ?? FIRST_CERTIFICATE,
    callback,
    isMainFrame: args.isMainFrame ?? true
  })
  return { preventDefault, callback }
}

describe('BrowserCertificateTrustController', () => {
  const guest = createGuest(7)
  const otherGuest = createGuest(8)
  const onFailureChanged = vi.fn()
  let now = 1_000
  let challengeNumber = 0
  let pageByGuestId: Map<number, string | null>
  let guestByPageId: Map<string, number>
  let guestById: Map<number, Electron.WebContents>
  let controller: BrowserCertificateTrustController

  beforeEach(() => {
    vi.clearAllMocks()
    resetSessionProxyApplicationForTests(browserSession)
    vi.mocked(guest.isDestroyed).mockReturnValue(false)
    vi.mocked(otherGuest.isDestroyed).mockReturnValue(false)
    vi.mocked(guest.loadURL).mockResolvedValue(undefined)
    vi.mocked(otherGuest.loadURL).mockResolvedValue(undefined)
    now = 1_000
    challengeNumber = 0
    pageByGuestId = new Map([
      [guest.id, 'page-1'],
      [otherGuest.id, 'page-2']
    ])
    guestByPageId = new Map([
      ['page-1', guest.id],
      ['page-2', otherGuest.id]
    ])
    guestById = new Map([
      [guest.id, guest],
      [otherGuest.id, otherGuest]
    ])
    controller = new BrowserCertificateTrustController({
      resolveManagedGuestContext: (webContentsId) => {
        if (!pageByGuestId.has(webContentsId)) {
          return null
        }
        return {
          browserPageId: pageByGuestId.get(webContentsId) ?? null,
          worktreeId: 'worktree-1',
          sessionProfileId: 'profile-1',
          owner: 'desktop-webview'
        }
      },
      resolveWebContentsIdForPage: (browserPageId) => guestByPageId.get(browserPageId) ?? null,
      resolveWebContents: (webContentsId) => guestById.get(webContentsId) ?? null,
      onFailureChanged,
      now: () => now,
      createChallengeId: () => `challenge-${++challengeNumber}`
    })
    controller.installSessionRequestGuard(browserSession)
  })

  it('keeps challenge ownership and expiry when reading a specific guest', () => {
    certificateEvent({ controller, guest })
    expect(controller.hasFailureForGuest(guest.id)).toBe(true)
    expect(controller.hasFailureForGuest(otherGuest.id)).toBe(false)
    now += 300_000
    expect(controller.hasFailureForGuest(guest.id)).toBe(false)
    expect(controller.proceed('page-1', 'challenge-1')).toEqual({ ok: false, reason: 'missing' })
  })

  it('blocks a session-cached certificate for sibling requests until that guest approves it', () => {
    certificateEvent({ controller, guest })
    expect(controller.proceed('page-1', 'challenge-1')).toEqual({ ok: true })
    expect(certificateEvent({ controller, guest }).callback).toHaveBeenCalledWith(true)

    const siblingMainFrame = beforeRequest({ webContentsId: otherGuest.id })
    expect(siblingMainFrame).toHaveBeenCalledWith({ cancel: true })
    expect(controller.getFailure('page-2')).toMatchObject({
      challengeId: 'challenge-2',
      browserPageId: 'page-2',
      origin: 'https://localhost:3443',
      canProceed: true
    })

    expect(
      beforeRequest({ webContentsId: otherGuest.id, resourceType: 'webSocket' })
    ).toHaveBeenCalledWith({ cancel: true })
    expect(beforeRequest({ resourceType: 'webSocket' })).toHaveBeenCalledWith({ cancel: true })
    expect(
      beforeRequest({ url: 'https://localhost:3444/app', webContentsId: otherGuest.id })
    ).toHaveBeenCalledWith({})
    expect(beforeRequest({ webContentsId: guest.id })).toHaveBeenCalledWith({})

    expect(controller.proceed('page-2', 'challenge-2')).toEqual({ ok: true })
    expect(beforeRequest({ webContentsId: otherGuest.id })).toHaveBeenCalledWith({})
  })
})
