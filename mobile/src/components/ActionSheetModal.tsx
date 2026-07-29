import { useRef, type ReactNode } from 'react'
import { ActivityIndicator, View, Text, Pressable, StyleSheet } from 'react-native'
import { Edit3, Trash2, type LucideIcon } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'

export type ActionSheetAction = {
  label: string
  icon?: LucideIcon
  renderIcon?: () => ReactNode
  destructive?: boolean
  disabled?: boolean
  hint?: string
  loading?: boolean
  skipAutoClose?: boolean
  closeBeforePress?: boolean
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
  if (icon) {
    return icon
  }
  if (destructive || /delete|remove/i.test(label)) {
    return Trash2
  }
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
          const customIcon = action.renderIcon?.()
          return (
            <View key={action.label}>
              {i > 0 && <View style={styles.separator} />}
              <Pressable
                style={({ pressed }) => [
                  styles.action,
                  action.disabled && styles.actionDisabled,
                  pressed && !action.disabled && !action.loading && styles.actionPressed
                ]}
                disabled={action.disabled || action.loading}
                onPress={() => {
                  action.onPress()
                  if (!action.skipAutoClose && onClose) {
                    onClose()
                  }
                }}
              >
                {customIcon ?? (
                  <Icon
                    size={16}
                    color={action.destructive ? colors.statusRed : colors.textSecondary}
                  />
                )}
                <View style={styles.actionTextBlock}>
                  <Text
                    style={[
                      styles.actionText,
                      action.destructive && styles.actionTextDestructive,
                      action.disabled && styles.actionTextDisabled
                    ]}
                  >
                    {action.label}
                  </Text>
                  {action.hint ? <Text style={styles.actionHint}>{action.hint}</Text> : null}
                </View>
                {action.loading ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : null}
              </Pressable>
            </View>
          )
        })}
      </View>
    </>
  )
}

export function ActionSheetModal({ visible, title, message, actions, onClose }: Props) {
  const pendingActionRef = useRef<(() => void) | null>(null)
  const sequencedActions = actions.map((action) =>
    action.closeBeforePress
      ? {
          ...action,
          onPress: () => {
            pendingActionRef.current = action.onPress
          }
        }
      : action
  )

  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      onAfterClose={() => {
        // Why: iOS cannot present a second native modal until the action
        // sheet's native window has fully unmounted.
        const pendingAction = pendingActionRef.current
        pendingActionRef.current = null
        pendingAction?.()
      }}
      dragContentToDismiss
    >
      <ActionSheetContent
        title={title}
        message={message}
        actions={sequencedActions}
        onClose={onClose}
      />
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
  actionDisabled: {
    opacity: 0.58
  },
  actionPressed: {
    backgroundColor: colors.bgRaised
  },
  actionTextBlock: {
    flex: 1,
    minWidth: 0
  },
  actionText: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  actionTextDisabled: {
    color: colors.textSecondary
  },
  actionTextDestructive: {
    color: colors.statusRed
  },
  actionHint: {
    marginTop: 2,
    fontSize: typography.metaSize,
    color: colors.textMuted
  }
})
