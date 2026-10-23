import { View } from 'react-native'
import type { WorkspaceSshGate } from '../tasks/workspace-ssh-gate'
import { workspaceSshStatusLabel } from '../tasks/workspace-ssh-gate'
import { newWorktreeFormStyles as styles } from './new-worktree-form-styles'
import { Banner } from './ui/Banner'

/** A disconnected SSH target blocks Create; this says so beside Run on, with the Connect that clears it. */
export function NewWorkspaceSshConnectionField({
  repoName,
  sshGate,
  onConnect
}: {
  repoName: string
  sshGate: WorkspaceSshGate
  onConnect: () => void
}) {
  if (sshGate.status === 'connected' && !sshGate.error) {
    return null
  }
  const failed = sshGate.error !== null && !sshGate.connectInProgress
  return (
    <View style={[styles.bleed, styles.bannerGap]}>
      <Banner
        tone={failed ? 'error' : 'warning'}
        title={workspaceSshStatusLabel(sshGate.status)}
        message={
          failed && sshGate.error
            ? sshGate.error
            : `Connect to ${repoName} over SSH to search sources and create a workspace there.`
        }
        action={
          sshGate.status === 'connected'
            ? undefined
            : {
                label: sshGate.connectInProgress ? 'Connecting…' : 'Connect',
                onPress: onConnect,
                busy: sshGate.connectInProgress
              }
        }
      />
    </View>
  )
}
