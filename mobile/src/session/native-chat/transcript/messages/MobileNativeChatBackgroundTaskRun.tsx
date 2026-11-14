import { Text, View } from 'react-native'
import type { NativeChatBackgroundTaskBlock } from '../../../../../../src/shared/native-chat/native-chat-types'
import { nativeChatBackgroundTaskRun } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-background-task-run'
import { AGENT_STATE_DOT_SIZE, AgentStateDot } from '../../../../components/AgentStateDot'
import { INLINE_TEXT_SELECTION } from '../../../../components/inline-text-selection'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { sayMobileBackgroundTask } from '../../input/tasks/mobile-background-task-copy'
import { BackgroundTaskKindIcon } from '../../input/tasks/MobileNativeChatBackgroundTasks'
import { scaledType } from './mobile-native-chat-message-styles'

const ICON_SIZE = 14

export function MobileNativeChatBackgroundTaskRun({
  block,
  fontScale
}: {
  block: NativeChatBackgroundTaskBlock
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const row = nativeChatBackgroundTaskRun(block, sayMobileBackgroundTask)
  const meta = scaledType(typography.metaSize, fontScale)
  // Lines up under the label, past the icon and the dot.
  const indent = { paddingLeft: ICON_SIZE * fontScale + AGENT_STATE_DOT_SIZE + 2 * spacing.sm }
  return (
    <View testID="background-task-run" style={styles.run}>
      <View style={styles.header}>
        {/* Faint for every kind, as on desktop: a settled monitor must not look live. */}
        <BackgroundTaskKindIcon
          kind={row.kind}
          size={ICON_SIZE * fontScale}
          color={colors.textMuted}
        />
        <AgentStateDot state={row.state} />
        <Text
          selectable={INLINE_TEXT_SELECTION}
          style={[styles.label, scaledType(typography.bodySize, fontScale)]}
          numberOfLines={1}
        >
          {row.label}
        </Text>
        <Text selectable={INLINE_TEXT_SELECTION} style={[styles.status, meta]}>
          {row.status}
        </Text>
      </View>
      {row.sentence === null ? null : (
        <Text
          selectable={INLINE_TEXT_SELECTION}
          style={[styles.detail, meta, indent, row.state === 'blocked' && styles.failed]}
        >
          {row.sentence}
        </Text>
      )}
      {row.output === null ? null : (
        <Text
          selectable={INLINE_TEXT_SELECTION}
          style={[styles.detail, styles.output, meta, indent]}
          numberOfLines={1}
        >
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
    color: colors.textPrimary
  },
  status: {
    marginLeft: 'auto',
    flexShrink: 0,
    color: colors.textMuted
  },
  detail: {
    color: colors.textMuted
  },
  failed: {
    color: colors.statusRed
  },
  output: {
    fontFamily: typography.monoFamily
  }
}))
