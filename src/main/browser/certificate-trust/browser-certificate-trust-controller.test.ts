import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserCertificateTrustController } from './browser-certificate-trust-controller'
import { resetSessionProxyApplicationForTests } from '../../network/proxy-settings'

const FIRST_CERTIFICATE = certificate('first certificate')
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub with every Session member the controller and proxy readiness read.
const browserSession = {
  resolveProxy: vi.fn(async () => 'DIRECT'),
  setProxy: vi.fn(async () => {}),
  closeAllConnections: vi.fn(async () => {}),
  webRequest: { onBeforeRequest: vi.fn() }
} as unknown as Electron.Session

function certificate(contents: string): Electron.Certificate {
  return {
    data: `-----BEGIN CERTIFICATE-----\n${Buffer.from(contents).toString('base64')}\n-----END CERTIFICATE-----`
  } as Electron.Certificate
}

function createGuest(id: number, session: Electron.Session = browserSession): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub with every WebContents member the controller reads.
  return {
    id,
    session,
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(() => Promise.resolve())
  } as unknown as Electron.WebContents
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

  it('trusts an approved certificate for every tab in the profile, and nothing else', () => {
    expect(certificateEvent({ controller, guest }).callback).toHaveBeenCalledWith(false)
    expect(controller.getFailure('page-1')).toMatchObject({ challengeId: 'challenge-1' })
    expect(controller.proceed('page-1', 'challenge-1')).toEqual({ ok: true })
    expect(guest.loadURL).toHaveBeenCalledWith('https://localhost:3443/app')

    const approved = certificateEvent({ controller, guest })
    expect(approved.preventDefault).toHaveBeenCalled()
    expect(approved.callback).toHaveBeenCalledWith(true)
    // A sibling tab in the same profile, and a redirect or subresource there, share the decision.
    expect(certificateEvent({ controller, guest: otherGuest }).callback).toHaveBeenCalledWith(true)
    expect(
      certificateEvent({ controller, guest: otherGuest, isMainFrame: false }).callback
    ).toHaveBeenCalledWith(true)
    // Another certificate on the approved endpoint is neither trusted nor offered.
    const replaced = certificateEvent({
      controller,
      guest: otherGuest,
      certificate: certificate('second certificate')
    })
    expect(replaced.callback).toHaveBeenCalledWith(false)
    expect(controller.getFailure('page-2')).toBeNull()
  })

  it('keeps another profile untrusted until it approves the certificate itself', () => {
    const otherProfile: Electron.Session = Object.create(browserSession)
    const guestInOtherProfile = createGuest(9, otherProfile)
    pageByGuestId.set(9, 'page-3')
    guestByPageId.set('page-3', 9)
    guestById.set(9, guestInOtherProfile)
    controller.installSessionRequestGuard(otherProfile)
    certificateEvent({ controller, guest })
    expect(controller.proceed('page-1', 'challenge-1')).toEqual({ ok: true })

    // A redirect or subresource reaching the endpoint from the other profile is refused.
    expect(
      certificateEvent({ controller, guest: guestInOtherProfile, isMainFrame: false }).callback
    ).toHaveBeenCalledWith(false)
    expect(controller.getFailure('page-3')).toBeNull()
    expect(
      certificateEvent({ controller, guest: guestInOtherProfile }).callback
    ).toHaveBeenCalledWith(false)
    expect(controller.getFailure('page-3')).toMatchObject({ challengeId: 'challenge-2' })
  })
})
