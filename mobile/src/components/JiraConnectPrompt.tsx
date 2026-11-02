import { colors } from '../theme/mobile-theme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileStateView } from './MobileStateView'
import { TaskProviderLogo } from './TaskProviderLogo'

type Props = {
  credentialError: string | null
  unavailableReason: string | null
  disabled: boolean
  onCheckAgain: () => void
  bottomInset?: number
}

// Jira credentials are managed on the paired desktop.
export function JiraConnectPrompt({
  credentialError,
  unavailableReason,
  disabled,
  onCheckAgain,
  bottomInset
}: Props) {
  const t = useMobileTranslation()
  return (
    <MobileStateView
      iconElement={<TaskProviderLogo provider="jira" size={24} color={colors.textMuted} />}
      title={
        unavailableReason
          ? t('components.jiraConnectPrompt.updateDesktop', 'Update Orca desktop')
          : t('components.jiraConnectPrompt.connectOnDesktop', 'Connect Jira on your desktop')
      }
      message={
        unavailableReason ??
        (credentialError
          ? t(
              'components.jiraConnectPrompt.credentialUnreadable',
              'Jira is saved but unreadable: {{credentialError}}',
              { credentialError }
            )
          : t(
              'components.jiraConnectPrompt.connectHint',
              'Add your Jira site in Orca desktop under Settings → Integrations, then check again.'
            ))
      }
      action={
        disabled
          ? null
          : {
              label: t('components.jiraConnectPrompt.checkAgain', 'Check again'),
              onPress: onCheckAgain
            }
      }
      bottomInset={bottomInset}
    />
  )
}
