import type { Session } from 'electron'
import { MAX_CERTIFICATE_GRANTS, type CertificateTrustGrant } from './browser-certificate-challenge'

function sameIdentity(left: CertificateTrustGrant, right: CertificateTrustGrant): boolean {
  return (
    left.secureEndpoint === right.secureEndpoint &&
    left.leafCertificateSha256 === right.leafCertificateSha256 &&
    left.error === right.error
  )
}

/**
 * The user's certificate exceptions, per browser profile session like a browser's per-profile
 * exceptions: an exact endpoint, leaf certificate and error, answered at Chromium's own
 * certificate-error decision. The network stack verifies every connection and redirect, so no
 * request listener is involved, and an approval applies to every tab in the profile.
 */
export class BrowserSessionCertificateDecisions {
  private readonly acceptedBySession = new Map<Session, Map<string, CertificateTrustGrant>>()

  /** Chromium caches an accepted certificate per session, so one identity is pinned per endpoint. */
  canOffer(session: Session, identity: CertificateTrustGrant): boolean {
    const accepted = this.acceptedBySession.get(session)?.get(identity.secureEndpoint)
    return accepted ? sameIdentity(accepted, identity) : true
  }

  accept(session: Session, identity: CertificateTrustGrant): boolean {
    let accepted = this.acceptedBySession.get(session)
    const existing = accepted?.get(identity.secureEndpoint)
    if (existing) {
      return sameIdentity(existing, identity)
    }
    // Bounded like the browser's own exception list: the oldest approval makes room.
    const oldest =
      accepted && accepted.size >= MAX_CERTIFICATE_GRANTS ? accepted.keys().next() : null
    if (accepted && oldest && !oldest.done) {
      accepted.delete(oldest.value)
    }
    if (!accepted) {
      accepted = new Map()
      this.acceptedBySession.set(session, accepted)
    }
    accepted.set(identity.secureEndpoint, {
      secureEndpoint: identity.secureEndpoint,
      leafCertificateSha256: identity.leafCertificateSha256,
      error: identity.error
    })
    return true
  }

  trusts(session: Session, identity: CertificateTrustGrant): boolean {
    const accepted = this.acceptedBySession.get(session)?.get(identity.secureEndpoint)
    return accepted !== undefined && sameIdentity(accepted, identity)
  }

  forget(session: Session): void {
    this.acceptedBySession.delete(session)
  }
}
