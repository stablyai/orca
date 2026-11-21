import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
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
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { mobileBrowserPaneStyles } from './mobile-browser-pane-styles'

type CertificateProceedState =
  | { challengeId: string; state: 'submitting' }
  | { challengeId: string; state: 'failed'; reason: MobileCertificateProceedFailure }

/** The desktop failure page's words over the streamed frame, which shows only a blank page. */
export function MobileBrowserLoadFailure({
  loadError,
  certificateFailure,
  browserPageId,
  certificateTrustSupported,
  retryDisabled,
  onRetry,
  onProceedCertificate
}: {
  loadError: BrowserLoadError
  certificateFailure: BrowserCertificateFailure | null | undefined
  browserPageId: string | null
  certificateTrustSupported: boolean
  retryDisabled: boolean
  onRetry: () => void
  onProceedCertificate: (challengeId: string) => Promise<MobileCertificateProceedFailure | null>
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [proceed, setProceed] = useState<CertificateProceedState | null>(null)
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
  const submitting = activeProceed?.state === 'submitting'
  const proceedCertificate = (challengeId: string) => {
    if (submitting) {
      return
    }
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
  return (
    <View pointerEvents="box-none" style={styles.page}>
      <View pointerEvents="box-none" style={styles.column}>
        <Text style={styles.title}>{text.title}</Text>
        {text.description ? <Text style={styles.description}>{text.description}</Text> : null}
        {failure.errorName ? <Text style={styles.code}>{failure.errorName}</Text> : null}
        {activeProceed?.state === 'failed' ? (
          <Text style={styles.proceedError}>
            {certificateProceedFailureText(t, activeProceed.reason)}
          </Text>
        ) : null}
        <View pointerEvents="box-none" style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={retryDisabled || submitting}
            style={({ pressed }) => [
              mobileBrowserPaneStyles.dialogButton,
              mobileBrowserPaneStyles.dialogButtonPrimary,
              pressed && mobileBrowserPaneStyles.dialogButtonPressed,
              (retryDisabled || submitting) && mobileBrowserPaneStyles.dialogButtonDisabled
            ]}
            onPress={onRetry}
          >
            <Text
              style={[
                mobileBrowserPaneStyles.dialogButtonText,
                mobileBrowserPaneStyles.dialogButtonPrimaryText
              ]}
            >
              {t('browser.loadFailure.retry', 'Retry')}
            </Text>
          </Pressable>
          {matchingCertificateFailure ? (
            <Pressable
              accessibilityRole="button"
              disabled={submitting}
              style={({ pressed }) => [
                mobileBrowserPaneStyles.dialogButton,
                styles.proceed,
                pressed && mobileBrowserPaneStyles.dialogButtonPressed,
                submitting && mobileBrowserPaneStyles.dialogButtonDisabled
              ]}
              onPress={() => proceedCertificate(matchingCertificateFailure.challengeId)}
            >
              <Text style={mobileBrowserPaneStyles.dialogButtonText}>
                {submitting
                  ? t('browser.loadFailure.connecting', 'Connecting…')
                  : t('browser.loadFailure.proceedUnsafe', 'Proceed Anyway (Unsafe)')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
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
  reason: MobileCertificateProceedFailure
): string {
  if (reason === 'host-update-needed') {
    return t(
      'browser.loadFailure.certificateProceedNeedsHostUpdate',
      'Update Orca on this host to accept certificate warnings from your phone.'
    )
  }
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

const styles = themedStyleSheet(() => ({
  page: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.bgBase
  },
  column: {
    width: '100%',
    maxWidth: 360,
    gap: spacing.sm
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600'
  },
  description: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20
  },
  code: {
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    marginTop: spacing.xs
  },
  proceedError: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    lineHeight: 18,
    marginTop: spacing.xs
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md
  },
  proceed: {
    backgroundColor: 'transparent'
  }
}))
