import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronLeft, Users } from 'lucide-react-native'
import {
  nativeChatListedSubagents,
  type NativeChatSubagentActivity
} from '../../../../../src/shared/native-chat/input/native-chat-activity'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MobileNativeChatSubagentSheet } from './MobileNativeChatSubagentSheet'
import {
  useMobileDismissedSubagents,
  type MobileDismissedSubagentScope
} from './use-mobile-dismissed-subagents'

export function MobileNativeChatActivityBar({
  subagents,
  focused,
  focusedTranscriptEmpty,
  onFocusSubagent,
  dismissalScope = null
}: {
  subagents: readonly NativeChatSubagentActivity[]
  focused: NativeChatSubagentActivity | null
  focusedTranscriptEmpty: boolean
  onFocusSubagent: (agentId: string | null) => void
  dismissalScope?: MobileDismissedSubagentScope | null
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [subagentsOpen, setSubagentsOpen] = useState(false)
  const listed = nativeChatListedSubagents(subagents)
  const { visible, dismiss } = useMobileDismissedSubagents(dismissalScope, listed)
  if (visible.length === 0 && subagentsOpen) {
    setSubagentsOpen(false)
  }
  if (visible.length === 0 && !focused) {
    return null
  }
  const working = visible.some((agent) => agent.state === 'working')
  const subagentLabel =
    visible.length === 1
      ? t('chat.activity.subagentPill', '{{count}} subagent', { count: visible.length })
      : t('chat.activity.subagentsPill', '{{count}} subagents', { count: visible.length })
  return (
    <View style={styles.bar}>
      {focused ? (
        <View style={styles.banner}>
          <View style={styles.bannerText}>
            <Text style={styles.bannerTitle} numberOfLines={1}>
              {t('chat.activity.viewingSubagent', 'Viewing {{name}}', { name: focused.label })}
            </Text>
            <Text style={styles.bannerMeta}>
              {t('chat.activity.composerStays', 'The composer still sends to the main agent.')}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => onFocusSubagent(null)}
            style={styles.bannerAction}
          >
            <ChevronLeft size={14} color={colors.textPrimary} strokeWidth={2} />
            <Text style={styles.bannerActionText}>
              {t('chat.activity.backToMain', 'Main agent')}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {focused && focusedTranscriptEmpty ? (
        <Text style={styles.bannerMeta}>
          {t('chat.activity.noMessages', 'No messages from this subagent yet')}
        </Text>
      ) : null}
      <View style={styles.pills}>
        {visible.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: subagentsOpen }}
            accessibilityLabel={t('chat.activity.openSubagents', 'Subagents, {{label}}', {
              label: subagentLabel
            })}
            testID="native-chat-subagents-pill"
            onPress={() => {
              setSubagentsOpen(true)
            }}
            style={styles.pill}
          >
            <Users size={14} color={colors.textSecondary} strokeWidth={2} />
            <Text style={styles.pillText}>{subagentLabel}</Text>
            {working ? <View style={styles.dot} /> : null}
          </Pressable>
        ) : null}
      </View>
      <BottomDrawer
        visible={subagentsOpen}
        onClose={() => setSubagentsOpen(false)}
        dragContentToDismiss
      >
        <MobileNativeChatSubagentSheet
          agents={visible}
          completed={subagents.filter((agent) => agent.state === 'completed')}
          showBack={focused != null}
          focusedId={focused?.id ?? null}
          onChoose={(agentId) => {
            setSubagentsOpen(false)
            onFocusSubagent(agentId)
          }}
          onDismiss={dismiss}
        />
      </BottomDrawer>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  bannerText: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  bannerTitle: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  bannerMeta: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  bannerAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.composerControl,
    borderRadius: radii.control
  },
  bannerActionText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  pills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 28,
    paddingHorizontal: spacing.sm + 2,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.composerControl
  },
  pillText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.textPrimary
  }
}))
