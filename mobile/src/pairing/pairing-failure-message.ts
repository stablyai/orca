import type { Translate } from '../i18n/mobile-i18n'
import { PairingCodeRejectedError } from './pairing-candidate-race'

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
    return screen === 'scan'
      ? t(
          'app.pairScan.connectTimedOut',
          "Couldn't connect within {{seconds}}s — see log below for where it stalled",
          { seconds }
        )
      : t(
          'app.pairConfirm.connectTimedOut',
          "Couldn't connect within {{seconds}}s — see log below for where it stalled",
          { seconds }
        )
  }
  // Desktops refuse an expired, rotated or already-used (single-use) code as unauthorized.
  if (error instanceof PairingCodeRejectedError) {
    return t(
      'app.pairScan.codeNoLongerValid',
      'This pairing code expired, was already used, or was replaced. Show a new code on your desktop and scan again.'
    )
  }
  return screen === 'scan'
    ? t('app.pairScan.pairingFailed', 'Pairing failed: {{error}}', { error: detail })
    : t('app.pairConfirm.pairingFailed', 'Pairing failed: {{error}}', { error: detail })
}
