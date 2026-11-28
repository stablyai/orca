import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { TaskProviderLogo } from '../../components/icons/TaskProviderLogo'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { HostUpdateNotice } from '../../host-update-notice/HostUpdateNotice'

type Props = {
  credentialError: string | null
  unavailableReason: string | null
  disabled: boolean
  onCheckAgain: () => void
  /** Null when the host cannot take Jira credentials from a phone; setup then stays on desktop. */
  onConnect: (() => void) | null
  bottomInset?: number
}

export function JiraConnectPrompt({
  credentialError,
  unavailableReason,
  disabled,
  onCheckAgain,
  onConnect,
  bottomInset
}: Props) {
  const colors = useMobileColors()
  const t = useMobileTranslation()
  if (unavailableReason) {
    return (
      <HostUpdateNotice
        variant="screen"
        feature={t('components.jiraConnectPrompt.needsNewerOrca', 'Jira needs a newer version.')}
        {...(bottomInset !== undefined ? { bottomInset } : {})}
      />
    )
  }
  const canConnect = onConnect !== null
  const unreadable = credentialError
    ? t(
        'components.jiraConnectPrompt.credentialUnreadable',
        'Jira is saved but unreadable: {{credentialError}}',
        { credentialError }
      )
    : null
  return (
    <MobileStateView
      iconElement={<TaskProviderLogo provider="jira" size={24} color={colors.textMuted} />}
      title={
        canConnect
          ? t('components.jiraConnectPrompt.connectTitle', 'Connect your Jira account')
          : t('components.jiraConnectPrompt.connectOnDesktop', 'Connect Jira on your desktop')
      }
      message={
        unreadable ??
        (canConnect
          ? t(
              'components.jiraConnectPrompt.connectMessage',
              'Browse and start work on your assigned Jira issues directly from Tasks.'
            )
          : t(
              'components.jiraConnectPrompt.connectHint',
              'Add your Jira site in Orca desktop under Settings → Integrations, then check again.'
            ))
      }
      action={
        disabled
          ? null
          : canConnect
            ? {
                label: t('components.jiraConnectPrompt.connect', 'Connect Jira'),
                onPress: onConnect
              }
            : {
                label: t('components.jiraConnectPrompt.checkAgain', 'Check again'),
                onPress: onCheckAgain
              }
      }
      bottomInset={bottomInset}
    />
  )
}
