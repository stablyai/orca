import { useCallback, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { CircleAlert, ShieldAlert } from 'lucide-react-native'
import type {
  BrowserCertificateFailure,
  BrowserLoadError
} from '../../../../src/shared/browser/workspaces/browser-workspace-types'
import { isChromiumCertificateErrorCode } from '../../../../src/shared/browser/certificate-trust/browser-certificate-errors'
import {
  browserCertificateFailureReason,
  browserCertificatePresentationLoadError,
  browserCertificateProceedFailureKind,
  matchBrowserCertificateFailure
} from '../../../../src/shared/browser/certificate-trust/browser-certificate-failure-match'
import type { MobileCertificateProceedFailure } from '../certificate/mobile-browser-certificate-proceed'
import {
  describeBrowserLoadFailure,
  formatBrowserLoadFailureText,
  isBrowserNetworkLoadFailure
} from '../../../../src/shared/browser/navigation/browser-load-failure'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { HostUpdateToast } from '../../host-update-notice/HostUpdateNotice'

type CertificateProceedState =
  | { challengeId: string; state: 'submitting' }
  | { challengeId: string; state: 'failed'; reason: MobileCertificateProceedFailure }

export type MobileBrowserLoadFailureState = {
  title: string
  message: string | null
  errorName: string | null
  certificate: boolean
  /** Waiting for the host to load the page past its certificate warning. */
  connecting: boolean
  /** The certificate warning's way past; the pane offers it in ⋯, never beside Retry. */
  proceedUnsafe: (() => void) | null
  /** Proceeding needs a newer Orca on the computer; said once as the shared update toast. */
  /** The refused proceed that needs a newer Orca on the computer, said once as the shared update toast. */
  hostUpdateChallengeId: string | null
}

/** The desktop failure page's words for a failed load, and its unsafe way past a certificate warning. */
export function useMobileBrowserLoadFailure({
  loadError,
  certificateFailure,
  browserPageId,
  certificateTrustSupported,
  onProceedCertificate
}: {
  loadError: BrowserLoadError | null | undefined
  certificateFailure: BrowserCertificateFailure | null | undefined
  browserPageId: string | null
  certificateTrustSupported: boolean
  onProceedCertificate: (challengeId: string) => Promise<MobileCertificateProceedFailure | null>
}): MobileBrowserLoadFailureState | null {
  const t = useMobileTranslation()
  const [proceed, setProceed] = useState<CertificateProceedState | null>(null)
  if (!loadError) {
    return null
  }
  const matchingCertificateFailure = matchBrowserCertificateFailure({
    loadError,
    certificateFailure,
    expectedBrowserPageId: browserPageId,
    canProceed: certificateTrustSupported
  })
  const presentationLoadError = browserCertificatePresentationLoadError(
    loadError,
    matchingCertificateFailure
  )
  const certificateError = isChromiumCertificateErrorCode(presentationLoadError.code)
  if (!certificateError && !isBrowserNetworkLoadFailure(presentationLoadError)) {
    return null
  }
  // Why no route: the phone can't see the SSH host's state, so SOCKS failures read as "can't reach".
  const failure = describeBrowserLoadFailure(presentationLoadError, null)
  const text = certificateError
    ? {
        title: t('browser.loadFailure.connectionNotSecure', "Connection isn't secure"),
        description: certificateFailureDescription(
          t,
          presentationLoadError.code,
          failure.host ?? 'this address'
        )
      }
    : formatBrowserLoadFailureText(presentationLoadError, failure)
  const activeProceed =
    proceed?.challengeId === matchingCertificateFailure?.challengeId ? proceed : null
  const connecting = activeProceed?.state === 'submitting'
  const proceedUnsafe =
    matchingCertificateFailure && !connecting
      ? () => {
          const { challengeId } = matchingCertificateFailure
          setProceed({ challengeId, state: 'submitting' })
          void onProceedCertificate(challengeId).then((reason) => {
            // On success stay "Connecting…": the host reloads the page and this view goes away.
            setProceed((current) =>
              current?.challengeId === challengeId && reason
                ? { challengeId, state: 'failed', reason }
                : current
            )
          })
        }
      : null
  return {
    title: text.title,
    message:
      activeProceed?.state === 'failed' && activeProceed.reason !== 'host-update-needed'
        ? certificateProceedFailureText(t, activeProceed.reason)
        : text.description,
    hostUpdateChallengeId:
      activeProceed?.state === 'failed' && activeProceed.reason === 'host-update-needed'
        ? activeProceed.challengeId
        : null,
    errorName: failure.errorName,
    certificate: certificateError,
    connecting,
    proceedUnsafe
  }
}

/** A failed load in the app's state view, over the blank frame the host streams for it. */
export function MobileBrowserLoadFailure({
  failure,
  retryDisabled,
  onRetry,
  showProceedUnsafe
}: {
  failure: MobileBrowserLoadFailureState
  retryDisabled: boolean
  onRetry: () => void
  showProceedUnsafe: boolean
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  // Each refused proceed says it once; Retry then asks for a new approval anyway.
  const [dismissedChallenge, setDismissedChallenge] = useState<string | null>(null)
  const challenge = failure.hostUpdateChallengeId
  const dismissToast = useCallback(() => setDismissedChallenge(challenge), [challenge])
  return (
    <View style={styles.page}>
      <HostUpdateToast
        visible={challenge !== null && challenge !== dismissedChallenge}
        onDismiss={dismissToast}
        bottomInset={0}
      />
      {failure.connecting ? (
        <MobileStateView loading title={t('browser.loadFailure.connecting', 'Connecting…')} />
      ) : (
        <MobileStateView
          icon={failure.certificate ? ShieldAlert : CircleAlert}
          title={failure.title}
          message={failure.message}
          details={failure.errorName}
          action={
            retryDisabled
              ? null
              : { label: t('browser.loadFailure.retry', 'Retry'), onPress: onRetry }
          }
          secondaryAction={
            showProceedUnsafe && failure.proceedUnsafe
              ? {
                  label: t('browser.loadFailure.proceedUnsafe', 'Proceed Anyway (Unsafe)'),
                  onPress: failure.proceedUnsafe
                }
              : null
          }
        />
      )}
    </View>
  )
}

type Translate = ReturnType<typeof useMobileTranslation>

function certificateFailureDescription(t: Translate, code: number, host: string): string {
  const reason = browserCertificateFailureReason(code)
  if (reason === 'name-mismatch') {
    return t(
      'browser.loadFailure.certificateNameMismatch',
      "The certificate doesn't match {{value0}}.",
      { value0: host }
    )
  }
  if (reason === 'date-invalid') {
    return t(
      'browser.loadFailure.certificateDateInvalid',
      "The certificate for {{value0}} isn't valid at the current date and time.",
      { value0: host }
    )
  }
  if (reason === 'authority-invalid') {
    return t(
      'browser.loadFailure.certificateAuthorityInvalid',
      "Orca doesn't trust the authority that issued the certificate for {{value0}}.",
      { value0: host }
    )
  }
  return t(
    'browser.loadFailure.certificateVerificationFailed',
    "Orca couldn't verify the certificate for {{value0}}.",
    { value0: host }
  )
}

function certificateProceedFailureText(
  t: Translate,
  reason: Exclude<MobileCertificateProceedFailure, 'host-update-needed'>
): string {
  const kind = browserCertificateProceedFailureKind(reason)
  if (kind === 'expired') {
    return t(
      'browser.loadFailure.certificateChallengeExpired',
      'This certificate approval expired. Retry the page to request a new one.'
    )
  }
  if (kind === 'changed') {
    return t(
      'browser.loadFailure.certificateChallengeChanged',
      'The certificate request changed. Retry the page and review the new warning.'
    )
  }
  if (kind === 'request-failed') {
    return t(
      'browser.loadFailure.certificateProceedFailed',
      'Orca could not approve this certificate request. Retry the page and try again.'
    )
  }
  return t(
    'browser.loadFailure.certificateChallengeUnavailable',
    'This certificate request is no longer available. Retry the page to request a new one.'
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  page: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.bgBase
  }
}))
