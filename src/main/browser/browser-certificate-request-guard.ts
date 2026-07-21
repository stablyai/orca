import type { Session } from 'electron'

import { toSecureCertificateEndpoint } from '../../shared/browser-url'
import { MAX_CERTIFICATE_GRANTS, type CertificateTrustGrant } from './browser-certificate-challenge'

type CertificateIdentity = Pick<
  CertificateTrustGrant,
  'secureEndpoint' | 'leafCertificateSha256' | 'error'
>

type BlockedMainFrame = CertificateIdentity & {
  webContentsId: number
  navigationUrl: string
  origin: string
  displayHost: string
}

type RequestGuardDependencies = {
  onBlockedMainFrame: (blocked: BlockedMainFrame) => void
}

function certificateIdentitiesMatch(
  left: CertificateIdentity | undefined,
  right: CertificateIdentity
): boolean {
  return Boolean(
    left &&
    left.secureEndpoint === right.secureEndpoint &&
    left.leafCertificateSha256 === right.leafCertificateSha256 &&
    left.error === right.error
  )
}

export class BrowserCertificateRequestGuard {
  private readonly grantsByGuestId = new Map<number, CertificateTrustGrant>()
  private readonly grantSessionByGuestId = new Map<number, Session>()
  private readonly guardedSessions = new Set<Session>()
  private readonly acceptedIdentityBySession = new Map<Session, Map<string, CertificateIdentity>>()

  constructor(private readonly dependencies: RequestGuardDependencies) {}

  installSession(session: Session): void {
    if (this.guardedSessions.has(session)) {
      return
    }
    // Why: Chromium caches certificate continuations at session scope. This
    // request gate restores the narrower per-WebContents approval boundary.
    session.webRequest.onBeforeRequest((details, callback) => {
      callback(this.shouldBlockRequest(session, details) ? { cancel: true } : {})
    })
    this.guardedSessions.add(session)
  }

  removeSession(session: Session): void {
    if (!this.guardedSessions.delete(session)) {
      return
    }
    session.webRequest.onBeforeRequest(null)
    this.acceptedIdentityBySession.delete(session)
    for (const [webContentsId, grantSession] of this.grantSessionByGuestId) {
      if (grantSession === session) {
        this.revokeGuest(webContentsId)
      }
    }
  }

  canOfferCertificate(session: Session, identity: CertificateIdentity): boolean {
    if (!this.guardedSessions.has(session)) {
      return false
    }
    const accepted = this.acceptedIdentityBySession.get(session)?.get(identity.secureEndpoint)
    // Why: the request gate cannot inspect TLS after Chromium caches a decision.
    // Never accept a second bad leaf for one endpoint in the same app process.
    return !accepted || certificateIdentitiesMatch(accepted, identity)
  }

  grant(session: Session, grant: CertificateTrustGrant): boolean {
    if (!this.guardedSessions.has(session)) {
      return false
    }
    let acceptedByEndpoint = this.acceptedIdentityBySession.get(session)
    const accepted = acceptedByEndpoint?.get(grant.secureEndpoint)
    // Why: once one leaf is accepted for an endpoint in this session, Chromium
    // caches the TLS decision. Refuse a conflicting pending leaf so proceed()
    // cannot report success when the next certificate-error will still fail.
    if (accepted && !certificateIdentitiesMatch(accepted, grant)) {
      return false
    }
    // Why: pin the identity at grant time, not only on the later certificate
    // callback, so a concurrent sibling proceed cannot race in a second leaf.
    if (!acceptedByEndpoint) {
      acceptedByEndpoint = new Map()
      this.acceptedIdentityBySession.set(session, acceptedByEndpoint)
    }
    acceptedByEndpoint.set(grant.secureEndpoint, {
      secureEndpoint: grant.secureEndpoint,
      leafCertificateSha256: grant.leafCertificateSha256,
      error: grant.error
    })
    this.grantsByGuestId.delete(grant.guestWebContentsId)
    this.grantsByGuestId.set(grant.guestWebContentsId, grant)
    this.grantSessionByGuestId.set(grant.guestWebContentsId, session)
    this.enforceGrantBound()
    return true
  }

  shouldTrustCertificate(
    session: Session,
    webContentsId: number,
    identity: CertificateIdentity
  ): boolean {
    if (
      !this.guardedSessions.has(session) ||
      this.grantSessionByGuestId.get(webContentsId) !== session ||
      !certificateIdentitiesMatch(this.grantsByGuestId.get(webContentsId), identity)
    ) {
      return false
    }
    let acceptedByEndpoint = this.acceptedIdentityBySession.get(session)
    if (!acceptedByEndpoint) {
      acceptedByEndpoint = new Map()
      this.acceptedIdentityBySession.set(session, acceptedByEndpoint)
    }
    const accepted = acceptedByEndpoint.get(identity.secureEndpoint)
    if (accepted && !certificateIdentitiesMatch(accepted, identity)) {
      return false
    }
    acceptedByEndpoint.set(identity.secureEndpoint, identity)
    return true
  }

  revokeGuest(webContentsId: number): void {
    this.grantsByGuestId.delete(webContentsId)
    this.grantSessionByGuestId.delete(webContentsId)
  }

  revokeForCommittedNavigation(webContentsId: number, url: string): void {
    const grant = this.grantsByGuestId.get(webContentsId)
    if (grant && toSecureCertificateEndpoint(url) !== grant.secureEndpoint) {
      this.revokeGuest(webContentsId)
    }
  }

  private shouldBlockRequest(
    session: Session,
    details: Electron.OnBeforeRequestListenerDetails
  ): boolean {
    const secureEndpoint = toSecureCertificateEndpoint(details.url)
    if (!secureEndpoint) {
      return false
    }
    const accepted = this.acceptedIdentityBySession.get(session)?.get(secureEndpoint)
    if (!accepted) {
      return false
    }
    const webContentsId = details.webContentsId ?? details.webContents?.id
    const grant = webContentsId === undefined ? undefined : this.grantsByGuestId.get(webContentsId)
    if (
      webContentsId !== undefined &&
      grant &&
      this.grantSessionByGuestId.get(webContentsId) === session &&
      certificateIdentitiesMatch(grant, accepted)
    ) {
      return false
    }
    if (details.resourceType === 'mainFrame' && webContentsId !== undefined) {
      this.reportBlockedMainFrame(webContentsId, details.url, accepted)
    }
    return true
  }

  private reportBlockedMainFrame(
    webContentsId: number,
    navigationUrl: string,
    identity: CertificateIdentity
  ): void {
    try {
      const parsed = new URL(navigationUrl)
      if (parsed.protocol !== 'https:') {
        return
      }
      this.dependencies.onBlockedMainFrame({
        webContentsId,
        navigationUrl,
        origin: parsed.origin,
        displayHost: parsed.host,
        ...identity
      })
    } catch {
      // The request remains blocked even if Chromium supplies a malformed URL.
    }
  }

  private enforceGrantBound(): void {
    while (this.grantsByGuestId.size > MAX_CERTIFICATE_GRANTS) {
      const oldest = this.grantsByGuestId.keys().next().value as number | undefined
      if (oldest === undefined) {
        return
      }
      this.revokeGuest(oldest)
    }
  }
}
