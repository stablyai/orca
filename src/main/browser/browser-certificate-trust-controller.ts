import { randomUUID } from 'node:crypto'
import type { BrowserCertificateFailure, BrowserCertificateProceedResult } from '../../shared/types'
import {
  isEligibleLocalCertificateHost,
  toSecureCertificateEndpoint
} from '../../shared/browser-url'
import {
  certificateChallengeIdentityMatches,
  CERTIFICATE_CHALLENGE_TTL_MS,
  MAX_PENDING_CERTIFICATE_CHALLENGES,
  toBrowserCertificateFailure,
  type BrowserCertificateTrustControllerDependencies,
  type PendingCertificateChallenge
} from './browser-certificate-challenge'
import {
  getLeafCertificateSha256,
  getSupportedCertificateErrorCode,
  normalizeCertificateError,
  SUPPORTED_CERTIFICATE_ERROR,
  SUPPORTED_CERTIFICATE_ERROR_CODE
} from './browser-certificate-identity'
import { BrowserCertificateRequestGuard } from './browser-certificate-request-guard'

export type { ManagedBrowserGuestContext } from './browser-certificate-challenge'

export class BrowserCertificateTrustController {
  private readonly pendingByGuestId = new Map<number, PendingCertificateChallenge>()
  private readonly navigationSequenceByGuestId = new Map<number, number>()
  private readonly expiryTimerByGuestId = new Map<number, ReturnType<typeof setTimeout>>()
  private readonly requestGuard: BrowserCertificateRequestGuard

  constructor(private readonly dependencies: BrowserCertificateTrustControllerDependencies) {
    this.requestGuard = new BrowserCertificateRequestGuard({
      onBlockedMainFrame: (blocked) => {
        const context = this.dependencies.resolveManagedGuestContext(blocked.webContentsId)
        if (context) {
          this.recordPendingChallenge({
            ...blocked,
            browserPageId: context.browserPageId
          })
        }
      }
    })
  }

  installSessionRequestGuard(session: Electron.Session): void {
    this.requestGuard.installSession(session)
  }
  removeSessionRequestGuard(session: Electron.Session): void {
    this.requestGuard.removeSession(session)
  }

  handleCertificateError(args: {
    event: Pick<Electron.Event, 'preventDefault'>
    webContents: Electron.WebContents
    url: string
    error: string
    certificate: Electron.Certificate
    callback: (isTrusted: boolean) => void
    isMainFrame: boolean
  }): void {
    let answered = false
    const answer = (trusted: boolean): void => {
      if (!answered) {
        answered = true
        args.callback(trusted)
      }
    }
    try {
      const context = this.dependencies.resolveManagedGuestContext(args.webContents.id)
      const parsed = new URL(args.url)
      const endpoint = toSecureCertificateEndpoint(args.url)
      const digest = getLeafCertificateSha256(args.certificate)
      const error = normalizeCertificateError(args.error)
      if (!context || !endpoint || !digest) {
        answer(false)
        return
      }
      const identity = { secureEndpoint: endpoint, leafCertificateSha256: digest, error }
      if (
        this.requestGuard.shouldTrustCertificate(
          args.webContents.session,
          args.webContents.id,
          identity
        )
      ) {
        args.event.preventDefault()
        answer(true)
        return
      }
      if (
        args.isMainFrame &&
        parsed.protocol === 'https:' &&
        error === SUPPORTED_CERTIFICATE_ERROR &&
        isEligibleLocalCertificateHost(parsed.hostname) &&
        this.requestGuard.canOfferCertificate(args.webContents.session, identity)
      ) {
        this.recordPendingChallenge({
          webContentsId: args.webContents.id,
          browserPageId: context.browserPageId,
          navigationUrl: args.url,
          origin: parsed.origin,
          displayHost: parsed.host,
          secureEndpoint: endpoint,
          leafCertificateSha256: digest,
          error
        })
      }
      answer(false)
    } catch (error) {
      // Why: fail closed, but log first — a throw in challenge recording would
      // otherwise present as "the cert prompt never appears" with no trace,
      // matching the logging catch in browser-manager's guest-state notifier.
      console.error('[browser-certificate-trust-controller] handleCertificateError failed', error)
      answer(false)
    }
  }

  onGuestRegistered(webContentsId: number, browserPageId: string): void {
    const pending = this.pendingByGuestId.get(webContentsId)
    if (!pending) {
      return
    }
    pending.browserPageId = browserPageId
    this.emitFailure(pending)
  }

  onGuestRetired(webContentsId: number): void {
    this.clearPending(webContentsId, true)
    this.requestGuard.revokeGuest(webContentsId)
    this.navigationSequenceByGuestId.delete(webContentsId)
  }

  onMainFrameNavigationStarted(webContentsId: number): void {
    this.navigationSequenceByGuestId.set(
      webContentsId,
      (this.navigationSequenceByGuestId.get(webContentsId) ?? 0) + 1
    )
    this.clearPending(webContentsId, true)
  }

  onMainFrameNavigationCommitted(webContentsId: number, url: string): void {
    this.requestGuard.revokeForCommittedNavigation(webContentsId, url)
  }

  getFailure(browserPageId: string): BrowserCertificateFailure | null {
    this.pruneExpired()
    for (const pending of this.pendingByGuestId.values()) {
      if (pending.browserPageId === browserPageId) {
        return toBrowserCertificateFailure(pending)
      }
    }
    return null
  }

  proceed(browserPageId: string, challengeId: string): BrowserCertificateProceedResult {
    const webContentsId = this.dependencies.resolveWebContentsIdForPage(browserPageId)
    if (webContentsId === null) {
      return { ok: false, reason: 'missing' }
    }
    const pending = this.pendingByGuestId.get(webContentsId)
    if (!pending) {
      return { ok: false, reason: 'missing' }
    }
    if (pending.challengeId !== challengeId || pending.browserPageId !== browserPageId) {
      return { ok: false, reason: 'changed' }
    }
    if (pending.expiresAt <= this.now()) {
      this.clearPending(webContentsId, true)
      return { ok: false, reason: 'expired' }
    }
    if (pending.errorCode !== SUPPORTED_CERTIFICATE_ERROR_CODE) {
      return { ok: false, reason: 'ineligible' }
    }
    if (pending.navigationSequence !== (this.navigationSequenceByGuestId.get(webContentsId) ?? 0)) {
      return { ok: false, reason: 'navigated' }
    }
    const context = this.dependencies.resolveManagedGuestContext(webContentsId)
    const guest = this.dependencies.resolveWebContents(webContentsId)
    if (!context || context.browserPageId !== browserPageId || !guest || guest.isDestroyed()) {
      return { ok: false, reason: 'missing' }
    }
    const granted = this.requestGuard.grant(guest.session, {
      guestWebContentsId: webContentsId,
      secureEndpoint: pending.secureEndpoint,
      leafCertificateSha256: pending.leafCertificateSha256,
      error: pending.error
    })
    if (!granted) {
      return { ok: false, reason: 'ineligible' }
    }
    const navigationUrl = pending.navigationUrl
    this.clearPending(webContentsId, true)
    void guest.loadURL(navigationUrl).catch(() => {})
    return { ok: true }
  }

  private recordPendingChallenge(args: {
    webContentsId: number
    browserPageId: string | null
    navigationUrl: string
    origin: string
    displayHost: string
    secureEndpoint: string
    leafCertificateSha256: string
    error: string
  }): void {
    const navigationSequence = this.navigationSequenceByGuestId.get(args.webContentsId) ?? 0
    const existing = this.pendingByGuestId.get(args.webContentsId)
    if (
      existing &&
      certificateChallengeIdentityMatches(existing, {
        navigationSequence,
        secureEndpoint: args.secureEndpoint,
        leafCertificateSha256: args.leafCertificateSha256,
        error: args.error
      })
    ) {
      return
    }
    this.clearPending(args.webContentsId, true)
    const observedAt = this.now()
    const pending: PendingCertificateChallenge = {
      challengeId: this.dependencies.createChallengeId?.() ?? randomUUID(),
      guestWebContentsId: args.webContentsId,
      browserPageId: args.browserPageId,
      navigationSequence,
      navigationUrl: args.navigationUrl,
      origin: args.origin,
      displayHost: args.displayHost,
      secureEndpoint: args.secureEndpoint,
      leafCertificateSha256: args.leafCertificateSha256,
      errorCode: getSupportedCertificateErrorCode(args.error),
      error: args.error,
      observedAt,
      expiresAt: observedAt + CERTIFICATE_CHALLENGE_TTL_MS
    }
    this.pendingByGuestId.set(args.webContentsId, pending)
    this.scheduleExpiry(pending)
    this.enforcePendingBound()
    this.emitFailure(pending)
  }

  private emitFailure(pending: PendingCertificateChallenge): void {
    if (pending.browserPageId) {
      this.dependencies.onFailureChanged(
        pending.guestWebContentsId,
        toBrowserCertificateFailure(pending),
        pending.navigationUrl
      )
    }
  }

  private clearPending(webContentsId: number, notify: boolean): void {
    const pending = this.pendingByGuestId.get(webContentsId)
    this.pendingByGuestId.delete(webContentsId)
    const timer = this.expiryTimerByGuestId.get(webContentsId)
    if (timer) {
      clearTimeout(timer)
      this.expiryTimerByGuestId.delete(webContentsId)
    }
    if (notify && pending?.browserPageId) {
      this.dependencies.onFailureChanged(webContentsId, null)
    }
  }

  private scheduleExpiry(pending: PendingCertificateChallenge): void {
    const timer = setTimeout(
      () => {
        if (
          this.pendingByGuestId.get(pending.guestWebContentsId)?.challengeId === pending.challengeId
        ) {
          this.clearPending(pending.guestWebContentsId, true)
        }
      },
      Math.max(0, pending.expiresAt - this.now())
    )
    timer.unref?.()
    this.expiryTimerByGuestId.set(pending.guestWebContentsId, timer)
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const pending of this.pendingByGuestId.values()) {
      if (pending.expiresAt <= now) {
        this.clearPending(pending.guestWebContentsId, true)
      }
    }
  }

  private enforcePendingBound(): void {
    while (this.pendingByGuestId.size > MAX_PENDING_CERTIFICATE_CHALLENGES) {
      const oldest = this.pendingByGuestId.keys().next().value as number | undefined
      if (oldest === undefined) {
        return
      }
      this.clearPending(oldest, true)
    }
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }
}
