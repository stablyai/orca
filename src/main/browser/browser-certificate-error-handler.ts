import type { ManagedBrowserGuestContext } from './browser-certificate-challenge'
import {
  getLeafCertificateSha256,
  normalizeCertificateError,
  SUPPORTED_CERTIFICATE_ERROR
} from './browser-certificate-identity'
import { isEligibleResolvedLocalCertificateHost } from './browser-certificate-host-eligibility'
import {
  isEligibleLocalCertificateHost,
  toSecureCertificateEndpoint
} from '../../shared/browser-url'

type CertificateIdentity = {
  secureEndpoint: string
  leafCertificateSha256: string
  error: string
}

export type BrowserCertificateChallengeInput = CertificateIdentity & {
  webContentsId: number
  browserPageId: string | null
  navigationUrl: string
  origin: string
  displayHost: string
}

type BrowserCertificateErrorEvent = {
  event: Pick<Electron.Event, 'preventDefault'>
  webContents: Electron.WebContents
  url: string
  error: string
  certificate: Electron.Certificate
  callback: (isTrusted: boolean) => void
  isMainFrame: boolean
}

type BrowserCertificateErrorHandlerDependencies = {
  resolveManagedGuestContext: (webContentsId: number) => ManagedBrowserGuestContext | null
  shouldTrustCertificate: (
    session: Electron.Session,
    webContentsId: number,
    identity: CertificateIdentity
  ) => boolean
  canOfferCertificate: (session: Electron.Session, identity: CertificateIdentity) => boolean
  getNavigationSequence: (webContentsId: number) => number
  recordPendingChallenge: (challenge: BrowserCertificateChallengeInput) => void
  isEligibleCertificateHost?: (
    hostname: string,
    url: string,
    session: Electron.Session
  ) => Promise<boolean>
  onError: (error: unknown) => void
}

export function handleBrowserCertificateError(
  args: BrowserCertificateErrorEvent,
  dependencies: BrowserCertificateErrorHandlerDependencies
): void {
  let answered = false
  const answer = (trusted: boolean): void => {
    if (!answered) {
      answered = true
      args.callback(trusted)
    }
  }
  try {
    const context = dependencies.resolveManagedGuestContext(args.webContents.id)
    const parsed = new URL(args.url)
    const secureEndpoint = toSecureCertificateEndpoint(args.url)
    const leafCertificateSha256 = getLeafCertificateSha256(args.certificate)
    const error = normalizeCertificateError(args.error)
    if (!context || !secureEndpoint || !leafCertificateSha256) {
      answer(false)
      return
    }
    const identity = { secureEndpoint, leafCertificateSha256, error }
    if (
      dependencies.shouldTrustCertificate(args.webContents.session, args.webContents.id, identity)
    ) {
      args.event.preventDefault()
      answer(true)
      return
    }
    if (
      !args.isMainFrame ||
      parsed.protocol !== 'https:' ||
      error !== SUPPORTED_CERTIFICATE_ERROR ||
      !dependencies.canOfferCertificate(args.webContents.session, identity)
    ) {
      answer(false)
      return
    }
    const challenge = {
      webContentsId: args.webContents.id,
      browserPageId: context.browserPageId,
      navigationUrl: args.url,
      origin: parsed.origin,
      displayHost: parsed.host,
      ...identity
    }
    if (isEligibleLocalCertificateHost(parsed.hostname)) {
      dependencies.recordPendingChallenge(challenge)
      answer(false)
      return
    }
    const navigationSequence = dependencies.getNavigationSequence(args.webContents.id)
    answer(false)
    const isEligibleCertificateHost =
      dependencies.isEligibleCertificateHost ??
      ((hostname, url, session) =>
        isEligibleResolvedLocalCertificateHost(hostname, url, (targetUrl) =>
          session.resolveProxy(targetUrl)
        ))
    void isEligibleCertificateHost(parsed.hostname, args.url, args.webContents.session)
      .then((eligible) => {
        const currentContext = dependencies.resolveManagedGuestContext(args.webContents.id)
        if (
          !eligible ||
          !currentContext ||
          navigationSequence !== dependencies.getNavigationSequence(args.webContents.id) ||
          !dependencies.canOfferCertificate(args.webContents.session, identity)
        ) {
          return
        }
        dependencies.recordPendingChallenge({
          ...challenge,
          browserPageId: currentContext.browserPageId
        })
      })
      .catch(dependencies.onError)
  } catch (error) {
    dependencies.onError(error)
    answer(false)
  }
}
