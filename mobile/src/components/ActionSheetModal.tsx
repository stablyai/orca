import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Edit3, Trash2, type LucideIcon } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'

export type ActionSheetAction = {
  label: string
  icon?: LucideIcon
  destructive?: boolean
  skipAutoClose?: boolean
  onPress: () => void
}

type Props = {
  visible: boolean
  title?: string
  message?: string
  actions: ActionSheetAction[]
  onClose: () => void
}

function iconForAction(label: string, destructive?: boolean, icon?: LucideIcon): LucideIcon {
  if (icon) return icon
  if (destructive || /delete|remove/i.test(label)) return Trash2
  return Edit3
}

type ContentProps = {
  title?: string
  message?: string
  actions: ActionSheetAction[]
  onClose?: () => void
}

export function ActionSheetContent({ title, message, actions, onClose }: ContentProps) {
  return (
    <>
      {(title || message) && (
        <View style={styles.header}>
          {title ? (
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
          {message ? <Text style={styles.message}>{message}</Text> : null}
        </View>
      )}

      <View style={styles.actionGroup}>
        {actions.map((action, i) => {
          const Icon = iconForAction(action.label, action.destructive, action.icon)
          return (
            <View key={action.label}>
              {i > 0 && <View style={styles.separator} />}
              <Pressable
                style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
                onPress={() => {
                  action.onPress()
                  if (!action.skipAutoClose && onClose) {
                    onClose()
                  }
                }}
              >
                <Icon
                  size={16}
                  color={action.destructive ? colors.statusRed : colors.textSecondary}
                />
                <Text
                  style={[styles.actionText, action.destructive && styles.actionTextDestructive]}
                >
                  {action.label}
                </Text>
              </Pressable>
            </View>
          )
        })}
      </View>
    </>
  )
}

export function ActionSheetModal({ visible, title, message, actions, onClose }: Props) {
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <ActionSheetContent title={title} message={message} actions={actions} onClose={onClose} />
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  title: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textMuted
  },
  message: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2
  },
  actionGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  actionPressed: {
    backgroundColor: colors.bgRaised
  },
  actionText: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  actionTextDestructive: {
    color: colors.statusRed
  }
})
