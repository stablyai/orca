import type { Translate } from '../i18n/mobile-i18n'
import { PairingCodeRejectedError } from './pairing-candidate-race'
import { RuntimeAccessLinkError } from './mobile-pairing-offer-scope'

/** Failure copy for a first pairing from the scan or confirm screen. */
export function getPairingFailureMessage(args: {
  screen: 'scan' | 'confirm'
  error: unknown
  timedOut: boolean
  timeoutMs: number
  t: Translate
}): string {
  const { screen, error, t } = args
  const seconds = args.timeoutMs / 1000
  const detail = error instanceof Error ? error.message : String(error)
  if (args.timedOut) {
    return t('app.pairing.connectTimedOut', 'Your computer didn’t answer in {{seconds}} seconds.', {
      seconds
    })
  }
  // Desktops refuse an expired, rotated or already-used (single-use) code as unauthorized.
  if (error instanceof PairingCodeRejectedError) {
    return t(
      'app.pairing.codeExpired',
      'This code expired or was already used. Show a new one on your computer.'
    )
  }
  if (error instanceof RuntimeAccessLinkError) {
    return t(
      'app.pairScan.runtimeAccessLink',
      'This link is for another Orca app. Scan the code in Settings → Mobile on your computer, or run orca pair --mobile on your server.'
    )
  }
  return screen === 'scan'
    ? t('app.pairScan.pairingFailed', 'Pairing failed: {{error}}', { error: detail })
    : t('app.pairConfirm.pairingFailed', 'Pairing failed: {{error}}', { error: detail })
}
