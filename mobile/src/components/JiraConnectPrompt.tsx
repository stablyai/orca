import { Plug } from 'lucide-react-native'
import { StateView } from './ui/StateView'

type Props = {
  credentialError: string | null
  unavailableReason: string | null
  disabled: boolean
  onCheckAgain: () => void
}

// Jira credentials are managed on the paired desktop.
export function JiraConnectPrompt({
  credentialError,
  unavailableReason,
  disabled,
  onCheckAgain
}: Props) {
  return (
    <StateView
      icon={Plug}
      title={unavailableReason ? 'Update Orca desktop' : 'Connect Jira on your desktop'}
      message={
        unavailableReason ??
        (credentialError
          ? `Jira is saved on your desktop but can't be read: ${credentialError}`
          : 'Add your Jira site in Orca on your desktop under Settings → Integrations, then check again.')
      }
      primary={disabled ? undefined : { label: 'Check again', onPress: onCheckAgain }}
    />
  )
}
