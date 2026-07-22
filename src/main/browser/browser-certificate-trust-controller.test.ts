import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserCertificateTrustController } from './browser-certificate-trust-controller'

const FIRST_CERTIFICATE = certificate('first certificate')
const SECOND_CERTIFICATE = certificate('replacement certificate')
let beforeRequestListener:
  | ((
      details: Electron.OnBeforeRequestListenerDetails,
      callback: (response: Electron.CallbackResponse) => void
    ) => void)
  | null = null
const browserSession = {
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

  it('rejects first, then trusts only the approved guest, endpoint, certificate, and error', () => {
    controller.onMainFrameNavigationStarted(guest.id)
    const first = certificateEvent({ controller, guest })

    expect(first.callback).toHaveBeenCalledOnce()
    expect(first.callback).toHaveBeenCalledWith(false)
    expect(first.preventDefault).not.toHaveBeenCalled()
    expect(controller.getFailure('page-1')).toMatchObject({
      challengeId: 'challenge-1',
      browserPageId: 'page-1',
      origin: 'https://localhost:3443',
      displayHost: 'localhost:3443',
      errorCode: -202,
      canProceed: true
    })

    expect(controller.proceed('page-1', 'challenge-1')).toEqual({ ok: true })
    expect(guest.loadURL).toHaveBeenCalledWith('https://localhost:3443/app')
    expect(onFailureChanged).toHaveBeenLastCalledWith(guest.id, null)

    const sameEndpoint = certificateEvent({
      controller,
      guest,
      url: 'wss://localhost:3443/socket'
    })
    expect(sameEndpoint.preventDefault).toHaveBeenCalledOnce()
    expect(sameEndpoint.callback).toHaveBeenCalledOnce()
    expect(sameEndpoint.callback).toHaveBeenCalledWith(true)

    const otherTab = certificateEvent({ controller, guest: otherGuest })
    expect(otherTab.callback).toHaveBeenCalledWith(false)
    expect(otherTab.preventDefault).not.toHaveBeenCalled()

    const otherPort = certificateEvent({
      controller,
      guest,
      url: 'https://localhost:3444/'
    })
    expect(otherPort.callback).toHaveBeenCalledWith(false)
    expect(otherPort.preventDefault).not.toHaveBeenCalled()

    const otherCertificate = certificateEvent({
      controller,
      guest,
      certificate: SECOND_CERTIFICATE
    })
    expect(otherCertificate.callback).toHaveBeenCalledWith(false)
    expect(otherCertificate.preventDefault).not.toHaveBeenCalled()
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

  it('fails closed when an accepted endpoint presents a replacement bad certificate', () => {
    certificateEvent({ controller, guest })
    expect(controller.proceed('page-1', 'challenge-1')).toEqual({ ok: true })
    expect(certificateEvent({ controller, guest }).callback).toHaveBeenCalledWith(true)

    controller.onMainFrameNavigationStarted(guest.id)
    const replacement = certificateEvent({ controller, guest, certificate: SECOND_CERTIFICATE })

    expect(replacement.callback).toHaveBeenCalledWith(false)
    expect(replacement.preventDefault).not.toHaveBeenCalled()
    expect(controller.getFailure('page-1')).toBeNull()
  })

  it('rejects proceed for a second tab whose pending leaf conflicts with an accepted identity', () => {
    // Both tabs observe different leaves before either is approved.
    certificateEvent({ controller, guest })
    certificateEvent({ controller, guest: otherGuest, certificate: SECOND_CERTIFICATE })
    expect(controller.getFailure('page-1')?.challengeId).toBe('challenge-1')
    expect(controller.getFailure('page-2')?.challengeId).toBe('challenge-2')

    expect(controller.proceed('page-1', 'challenge-1')).toEqual({ ok: true })
    // First proceed pins the session identity; the sibling's conflicting leaf
    // must not report success (Chromium cannot honor a second bad leaf).
    expect(controller.proceed('page-2', 'challenge-2')).toEqual({
      ok: false,
      reason: 'ineligible'
    })
    expect(otherGuest.loadURL).not.toHaveBeenCalled()
  })

  it('never offers approval for public hosts, non-authority failures, or subframes', () => {
    for (const event of [
      certificateEvent({ controller, guest, url: 'https://example.com/' }),
      certificateEvent({ controller, guest, error: 'ERR_CERT_DATE_INVALID' }),
      certificateEvent({ controller, guest, isMainFrame: false })
    ]) {
      expect(event.callback).toHaveBeenCalledOnce()
      expect(event.callback).toHaveBeenCalledWith(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
    expect(controller.getFailure('page-1')).toBeNull()
    expect(onFailureChanged).not.toHaveBeenCalled()
  })

  it('queues an early challenge until the guest receives its browser page identity', () => {
    pageByGuestId.set(guest.id, null)
    certificateEvent({ controller, guest })

    expect(onFailureChanged).not.toHaveBeenCalled()
    expect(controller.getFailure('page-1')).toBeNull()

    pageByGuestId.set(guest.id, 'page-1')
    controller.onGuestRegistered(guest.id, 'page-1')

    expect(onFailureChanged).toHaveBeenCalledWith(
      guest.id,
      expect.objectContaining({ challengeId: 'challenge-1', browserPageId: 'page-1' }),
      'https://localhost:3443/app'
    )
  })

  it('rejects stale, expired, destroyed, and mismatched approval attempts', () => {
    certificateEvent({ controller, guest })

    expect(controller.proceed('page-1', 'wrong-challenge')).toEqual({
      ok: false,
      reason: 'changed'
    })
    now += 5 * 60_000
    expect(controller.proceed('page-1', 'challenge-1')).toEqual({
      ok: false,
      reason: 'expired'
    })

    certificateEvent({ controller, guest })
    vi.mocked(guest.isDestroyed).mockReturnValue(true)
    expect(controller.proceed('page-1', 'challenge-2')).toEqual({
      ok: false,
      reason: 'missing'
    })
    expect(guest.loadURL).not.toHaveBeenCalled()
  })

  it('clears pending approval and grants when navigation or guest ownership changes', () => {
    certificateEvent({ controller, guest })
    controller.onMainFrameNavigationStarted(guest.id)
    expect(controller.getFailure('page-1')).toBeNull()
    expect(controller.proceed('page-1', 'challenge-1')).toEqual({
      ok: false,
      reason: 'missing'
    })

    certificateEvent({ controller, guest })
    expect(controller.proceed('page-1', 'challenge-2')).toEqual({ ok: true })
    controller.onMainFrameNavigationCommitted(guest.id, 'https://example.com/')
    const afterCommit = certificateEvent({ controller, guest })
    expect(afterCommit.callback).toHaveBeenCalledWith(false)

    controller.onGuestRetired(guest.id)
    expect(controller.getFailure('page-1')).toBeNull()
  })

  it('answers malformed and unmanaged events exactly once without overriding Electron', () => {
    pageByGuestId.delete(guest.id)
    const unmanaged = certificateEvent({ controller, guest })
    const malformedUrl = certificateEvent({ controller, guest: otherGuest, url: 'not a URL' })
    const malformedCertificate = certificateEvent({
      controller,
      guest: otherGuest,
      certificate: { data: 'not a PEM certificate' } as Electron.Certificate
    })

    for (const event of [unmanaged, malformedUrl, malformedCertificate]) {
      expect(event.callback).toHaveBeenCalledOnce()
      expect(event.callback).toHaveBeenCalledWith(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
  })
})
