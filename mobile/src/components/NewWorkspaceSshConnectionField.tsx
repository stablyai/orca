import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { WorkspaceSshGate } from '../tasks/workspace-ssh-gate'
import { workspaceSshStatusLabel } from '../tasks/workspace-ssh-gate'
import { newWorktreeFormStyles as styles } from './new-worktree-form-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function NewWorkspaceSshConnectionField({
  repoName,
  sshGate,
  onConnect
}: {
  repoName: string
  sshGate: WorkspaceSshGate
  onConnect: () => void
}) {
  useMobileColorScheme()
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
            <Text style={styles.sshSubtitle}>{workspaceSshStatusLabel(sshGate.status)}</Text>
          </View>
          {sshGate.status === 'connected' ? null : (
            <Pressable
              style={[styles.sshConnectButton, sshGate.connectInProgress && styles.disabled]}
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
