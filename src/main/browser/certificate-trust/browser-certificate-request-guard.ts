import type { Session } from 'electron'

import { toSecureCertificateEndpoint } from '../../../shared/browser/navigation/browser-url'
import { getProxySessionApplicationReadiness } from '../../network/proxy-settings'
import { onProxySessionReadinessChanged } from '../../network/proxy-session-readiness-listeners'
import { MAX_CERTIFICATE_GRANTS, type CertificateTrustGrant } from './browser-certificate-challenge'
import { answerBrowserSessionBeforeRequest } from '../sessions/requests/browser-session-request-decisions'
import { reportBrowserSessionWebRequest } from '../sessions/requests/browser-session-web-request-observer'
import { holdBrowserSessionWebRequest } from '../sessions/requests/browser-session-web-request-owner'

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
  private readonly guardedSessions = new Map<
    Session,
    { release: (() => void) | null; stop: () => void }
  >()
  private readonly acceptedIdentityBySession = new Map<Session, Map<string, CertificateIdentity>>()
  private readonly unsettledFirstGrants = new Set<Session>()

  constructor(private readonly dependencies: RequestGuardDependencies) {
    onProxySessionReadinessChanged((proxySession) => {
      for (const session of this.guardedSessions.keys()) {
        if (session === proxySession) {
          this.refresh(session)
        }
      }
    })
  }

  installSession(session: Session): void {
    if (this.guardedSessions.has(session)) {
      return
    }
    const refresh = (): void => this.refresh(session)
    session.extensions?.on('extension-loaded', refresh)
    session.extensions?.on('extension-unloaded', refresh)
    this.guardedSessions.set(session, {
      release: null,
      stop: () => {
        session.extensions?.off('extension-loaded', refresh)
        session.extensions?.off('extension-unloaded', refresh)
      }
    })
    this.refresh(session)
  }

  removeSession(session: Session): void {
    const guarded = this.guardedSessions.get(session)
    if (!guarded) {
      return
    }
    this.guardedSessions.delete(session)
    this.unsettledFirstGrants.delete(session)
    guarded.stop()
    guarded.release?.()
    this.acceptedIdentityBySession.delete(session)
    for (const [webContentsId, grantSession] of this.grantSessionByGuestId) {
      if (grantSession === session) {
        this.revokeGuest(webContentsId)
      }
    }
  }

  /**
   * Any session listener makes every page request wait on main (Electron's per-request loader
   * gate), so the guard listens only while it can block something: until the newest proxy policy
   * applies, once a bad certificate is accepted (Chromium then trusts it for every tab), and while
   * extensions need request decisions. Requests already in flight keep their route, redirects
   * included.
   */
  private refresh(session: Session): void {
    const guarded = this.guardedSessions.get(session)
    if (!guarded) {
      return
    }
    const needed =
      getProxySessionApplicationReadiness(session) !== true ||
      (this.acceptedIdentityBySession.get(session)?.size ?? 0) > 0 ||
      (session.extensions?.getAllExtensions().length ?? 0) > 0
    if (needed && !guarded.release) {
      guarded.release = this.listen(session)
    } else if (!needed && guarded.release) {
      guarded.release()
      guarded.release = null
    }
  }

  private listen(session: Session): () => void {
    return holdBrowserSessionWebRequest(session, 'onBeforeRequest', (details, callback) => {
      reportBrowserSessionWebRequest(session, 'onBeforeRequest', details)
      const readiness = getProxySessionApplicationReadiness(session)
      const answer = (ready: boolean): void => {
        if (!ready || this.shouldBlockRequest(session, details)) {
          callback({ cancel: true })
        } else {
          answerBrowserSessionBeforeRequest(session, details, callback)
        }
      }
      if (typeof readiness === 'boolean') {
        answer(readiness)
      } else {
        void readiness.then(answer)
      }
    })
  }

  /**
   * Requests that started before the guard listened keep their route through redirects, so a
   * session's first grant ends them before the reload lets Chromium cache this trust.
   */
  async settleGrant(session: Session): Promise<void> {
    if (this.unsettledFirstGrants.delete(session)) {
      await Promise.resolve(session.closeAllConnections?.()).catch(() => {})
    }
  }

  canOfferCertificate(session: Session, identity: CertificateIdentity): boolean {
    if (!this.guardedSessions.has(session)) {
      return false
    }
    const accepted = this.acceptedIdentityBySession.get(session)?.get(identity.secureEndpoint)
    // Cached TLS decisions hide later certificates; pin one identity per endpoint in this session.
    return !accepted || certificateIdentitiesMatch(accepted, identity)
  }

  grant(session: Session, grant: CertificateTrustGrant): boolean {
    if (!this.guardedSessions.has(session)) {
      return false
    }
    let acceptedByEndpoint = this.acceptedIdentityBySession.get(session)
    const accepted = acceptedByEndpoint?.get(grant.secureEndpoint)
    // Reject conflicting pending identities before proceed can report success.
    if (accepted && !certificateIdentitiesMatch(accepted, grant)) {
      return false
    }
    // Pin before the certificate callback so concurrent sibling approvals cannot accept a second identity.
    if (!acceptedByEndpoint) {
      acceptedByEndpoint = new Map()
      this.acceptedIdentityBySession.set(session, acceptedByEndpoint)
    }
    if (acceptedByEndpoint.size === 0) {
      this.unsettledFirstGrants.add(session)
    }
    acceptedByEndpoint.set(grant.secureEndpoint, {
      secureEndpoint: grant.secureEndpoint,
      leafCertificateSha256: grant.leafCertificateSha256,
      error: grant.error
    })
    this.refresh(session)
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
    this.refresh(session)
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
