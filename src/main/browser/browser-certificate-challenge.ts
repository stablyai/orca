import type { BrowserCertificateFailure } from '../../shared/types'
import { SUPPORTED_CERTIFICATE_ERROR_CODE } from './browser-certificate-identity'

export const CERTIFICATE_CHALLENGE_TTL_MS = 5 * 60_000
export const MAX_PENDING_CERTIFICATE_CHALLENGES = 32
export const MAX_CERTIFICATE_GRANTS = 32

export type ManagedBrowserGuestContext = {
  browserPageId: string | null
  worktreeId: string | null
  sessionProfileId: string | null
  owner: 'desktop-webview' | 'offscreen'
}

export type BrowserCertificateTrustControllerDependencies = {
  resolveManagedGuestContext: (webContentsId: number) => ManagedBrowserGuestContext | null
  resolveWebContentsIdForPage: (browserPageId: string) => number | null
  resolveWebContents: (webContentsId: number) => Electron.WebContents | null
  onFailureChanged: (
    webContentsId: number,
    failure: BrowserCertificateFailure | null,
    navigationUrl?: string
  ) => void
  now?: () => number
  createChallengeId?: () => string
}

export type PendingCertificateChallenge = {
  challengeId: string
  guestWebContentsId: number
  browserPageId: string | null
  navigationSequence: number
  navigationUrl: string
  origin: string
  displayHost: string
  secureEndpoint: string
  leafCertificateSha256: string
  errorCode: number | null
  error: string
  observedAt: number
  expiresAt: number
}

export type CertificateTrustGrant = Pick<
  PendingCertificateChallenge,
  'guestWebContentsId' | 'secureEndpoint' | 'leafCertificateSha256' | 'error'
>

export function certificateChallengeIdentityMatches(
  challenge: PendingCertificateChallenge,
  candidate: Pick<
    PendingCertificateChallenge,
    'navigationSequence' | 'secureEndpoint' | 'leafCertificateSha256' | 'error'
  >
): boolean {
  return (
    challenge.navigationSequence === candidate.navigationSequence &&
    challenge.secureEndpoint === candidate.secureEndpoint &&
    challenge.leafCertificateSha256 === candidate.leafCertificateSha256 &&
    challenge.error === candidate.error
  )
}

export function toBrowserCertificateFailure(
  challenge: PendingCertificateChallenge
): BrowserCertificateFailure {
  return {
    challengeId: challenge.challengeId,
    browserPageId: challenge.browserPageId ?? '',
    errorCode: challenge.errorCode,
    error: challenge.error,
    origin: challenge.origin,
    displayHost: challenge.displayHost,
    canProceed: challenge.errorCode === SUPPORTED_CERTIFICATE_ERROR_CODE,
    observedAt: challenge.observedAt
  }
}
