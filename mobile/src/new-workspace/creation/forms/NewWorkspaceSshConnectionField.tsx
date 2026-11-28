import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { WorkspaceSshGate } from '../workspace-ssh-gate'
import { workspaceSshStatusLabel } from '../workspace-ssh-gate'
import { newWorktreeFormStylesSheet } from './new-worktree-form-styles'
import { pressedStyle } from '../../../theme/mobile-theme'
import { useThemedStyles } from '../../../theme/themed-styles'

export function NewWorkspaceSshConnectionField({
  repoName,
  sshGate,
  onConnect
}: {
  repoName: string
  sshGate: WorkspaceSshGate
  onConnect: () => void
}) {
  const styles = useThemedStyles(newWorktreeFormStylesSheet)
  const t = useMobileTranslation()
  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {t('components.newWorkspaceSshConnectionField.label', 'SSH Connection')}
      </Text>
      <View style={styles.sshBox}>
        <View style={styles.sshRow}>
          <View
            style={[
              styles.sshDot,
              sshGate.status === 'connected'
                ? styles.sshDotConnected
                : sshGate.connectInProgress
                  ? styles.sshDotProgress
                  : styles.sshDotDisconnected
            ]}
          />
          <View style={styles.sshCopy}>
            <Text style={styles.sshTitle} numberOfLines={1}>
              {repoName}
            </Text>
            <Text style={styles.sshSubtitle}>{workspaceSshStatusLabel(sshGate.status, t)}</Text>
          </View>
          {sshGate.status === 'connected' ? null : (
            <Pressable
              style={({ pressed }) => [
                styles.sshConnectButton,
                sshGate.connectInProgress && styles.disabled,
                pressed && pressedStyle
              ]}
              disabled={sshGate.connectInProgress}
              onPress={onConnect}
            >
              <Text style={styles.sshConnectText}>
                {sshGate.connectInProgress
                  ? t('components.newWorkspaceSshConnectionField.connecting', 'Connecting...')
                  : t('components.newWorkspaceSshConnectionField.connect', 'Connect')}
              </Text>
            </Pressable>
          )}
        </View>
        {sshGate.error ? <Text style={styles.errorInline}>{sshGate.error}</Text> : null}
        {sshGate.needsDesktopServerRecovery ? (
          <Text style={styles.sshSubtitle}>
            {t(
              'components.newWorkspaceSshConnectionField.serverRecovery',
              'Its server needs recovering from the desktop: Settings → SSH hosts → Recover server.'
            )}
          </Text>
        ) : null}
      </View>
    </View>
  )
}
