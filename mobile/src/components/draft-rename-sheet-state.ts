import { ClockFading, CloudOff } from 'lucide-react-native'
import type { Translate } from '../i18n/mobile-i18n'
import type { HostMutationPhase } from '../query/host-mutation'

// A rename sheet over a draft-mode write: never claims a name the desktop hasn't taken.
export function draftRenameSheetState({
  blockedOffline,
  phase,
  error,
  hostName,
  t
}: {
  blockedOffline: boolean
  /** This sheet's own save. */
  phase: HostMutationPhase
  error: string | null
  hostName: string
  t: Translate
}) {
  const unconfirmed = phase === 'unconfirmed'
  const notice = unconfirmed
    ? {
        icon: ClockFading,
        text: t(
          'hostMutation.renameUnconfirmed',
          'Not confirmed yet. Orca checks the name when {{host}} is back.',
          { host: hostName }
        )
      }
    : blockedOffline
      ? {
          icon: CloudOff,
          text: t(
            'hostMutation.renameOffline',
            '{{host}} is offline. Your text stays here until you can save.',
            { host: hostName }
          )
        }
      : null
  return {
    notice,
    submitBlocked: blockedOffline,
    submitLabel: error
      ? t('common.retry', 'Retry')
      : unconfirmed
        ? t('hostMutation.saving', 'Saving')
        : undefined
  }
}
