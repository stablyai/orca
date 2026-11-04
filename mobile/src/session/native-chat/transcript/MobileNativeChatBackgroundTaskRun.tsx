import { Text, View } from 'react-native'
import type { NativeChatBackgroundTaskBlock } from '../../../../../src/shared/native-chat/native-chat-types'
import { nativeChatBackgroundTaskRun } from '../../../../../src/shared/native-chat/transcript/native-chat-background-task-run'
import { AgentStateDot } from '../../../components/AgentStateDot'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { sayMobileBackgroundTask } from '../../mobile-background-task-copy'
import { BackgroundTaskKindIcon } from '../input/MobileNativeChatBackgroundTasks'

const ICON_SIZE = 14
const DOT_SIZE = 10

export function MobileNativeChatBackgroundTaskRun({
  block
}: {
  block: NativeChatBackgroundTaskBlock
}): React.JSX.Element {
  useMobileColorScheme()
  const row = nativeChatBackgroundTaskRun(block, sayMobileBackgroundTask)
  return (
    <View testID="background-task-run" style={styles.run}>
      <View style={styles.header}>
        <BackgroundTaskKindIcon kind={row.kind} size={ICON_SIZE} />
        <AgentStateDot state={row.state} />
        <Text style={styles.label} numberOfLines={1}>
          {row.label}
        </Text>
        <Text style={styles.status}>{row.status}</Text>
      </View>
      {row.sentence === null ? null : (
        <Text style={[styles.detail, row.state === 'blocked' && styles.failed]}>
          {row.sentence}
        </Text>
      )}
      {row.output === null ? null : (
        <Text style={[styles.detail, styles.output]} numberOfLines={1} ellipsizeMode="middle">
          {row.output}
        </Text>
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  run: {
    paddingVertical: spacing.xs
  },
  header: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  label: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  status: {
    marginLeft: 'auto',
    flexShrink: 0,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  // Lines up under the label, past the icon and the dot.
  detail: {
    paddingLeft: ICON_SIZE + DOT_SIZE + 2 * spacing.sm,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  failed: {
    color: colors.statusRed
  },
  output: {
    fontFamily: typography.monoFamily
  }
}))
