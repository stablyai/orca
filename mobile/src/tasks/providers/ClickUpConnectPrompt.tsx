import { colors } from '../../theme/mobile-theme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { TaskProviderLogo } from '../../components/icons/TaskProviderLogo'

type Props = {
  credentialError: string | null
  unavailableReason: string | null
  lostConnection: boolean
  unreachable: boolean
  disabled: boolean
  onCheckAgain: () => void
  bottomInset?: number
}

// The ClickUp token is managed on the paired desktop.
export function ClickUpConnectPrompt({
  credentialError,
  unavailableReason,
  lostConnection,
  unreachable,
  disabled,
  onCheckAgain,
  bottomInset
}: Props) {
  const t = useMobileTranslation()
  return (
    <MobileStateView
      iconElement={<TaskProviderLogo provider="clickup" size={24} color={colors.textMuted} />}
      title={
        unavailableReason
          ? t('components.clickUpConnectPrompt.updateDesktop', 'Update Orca on this host')
          : unreachable
            ? t('components.clickUpConnectPrompt.unreachableTitle', "Couldn't reach your desktop")
            : lostConnection
              ? t(
                  'components.clickUpConnectPrompt.reconnectOnDesktop',
                  'Reconnect ClickUp on your desktop'
                )
              : t(
                  'components.clickUpConnectPrompt.connectOnDesktop',
                  'Connect ClickUp on your desktop'
                )
      }
      message={
        unavailableReason ??
        (unreachable
          ? t(
              'components.clickUpConnectPrompt.unreachableMessage',
              "Orca couldn't read the ClickUp connection from your desktop. Check that Orca is running there, then check again."
            )
          : credentialError
            ? t(
                'components.clickUpConnectPrompt.credentialUnreadable',
                'ClickUp is saved but unreadable: {{credentialError}}',
                { credentialError }
              )
            : lostConnection
              ? t(
                  'components.clickUpConnectPrompt.lostConnection',
                  'ClickUp was disconnected or rejected the saved token. Add your personal API token again in Orca desktop under Settings → Integrations, then check again.'
                )
              : t(
                  'components.clickUpConnectPrompt.connectHint',
                  'Add your ClickUp personal API token in Orca desktop under Settings → Integrations, then check again.'
                ))
      }
      action={
        disabled
          ? null
          : {
              label: t('components.clickUpConnectPrompt.checkAgain', 'Check again'),
              onPress: onCheckAgain
            }
      }
      bottomInset={bottomInset}
    />
  )
}
