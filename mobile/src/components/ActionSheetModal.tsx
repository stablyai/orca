import { useRef, type ReactNode } from 'react'
import { ActivityIndicator, View, Text, Pressable, StyleSheet } from 'react-native'
import { Copy, Ellipsis, Pencil, RefreshCw, Trash2, X, type LucideIcon } from 'lucide-react-native'
import { colors, motion, spacing, textStyles } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import { ListGroup, LIST_LEADING_INSET, LIST_ROW_PADDING } from './ui/ListGroup'
import { pressTransition } from './ui/transition-styles'

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

// Why: callers that pass no icon still get one that names the verb; closing a tab is an X, not a bin.
const FALLBACK_ICONS: [RegExp, LucideIcon][] = [
  [/^close/i, X],
  [/delete|remove|discard/i, Trash2],
  [/rename|edit/i, Pencil],
  [/copy/i, Copy],
  [/refresh|reload/i, RefreshCw]
]

function iconForAction(label: string, destructive?: boolean, icon?: LucideIcon): LucideIcon {
  if (icon) {
    return icon
  }
  const match = FALLBACK_ICONS.find(([pattern]) => pattern.test(label))
  if (match) {
    return match[1]
  }
  return destructive ? Trash2 : Ellipsis
}

type ContentProps = {
  title?: string
  message?: string
  /** Drawn between the header and the actions. */
  children?: ReactNode
  actions: ActionSheetAction[]
  onClose?: () => void
}

/** An iOS action sheet: grey title and message, one inset group of actions, and Cancel on its own. */
export function ActionSheetContent({ title, message, children, actions, onClose }: ContentProps) {
  return (
    <View style={styles.root}>
      {(title || message) && (
        <View style={styles.header}>
          {title ? (
            <Text style={styles.title} numberOfLines={2} accessibilityRole="header">
              {title}
            </Text>
          ) : null}
          {message ? <Text style={styles.message}>{message}</Text> : null}
        </View>
      )}

      {children}

      {actions.length > 0 ? (
        <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.group}>
          {actions.map((action) => (
            <ActionRow key={action.label} action={action} onClose={onClose} />
          ))}
        </ListGroup>
      ) : null}

      {onClose ? (
        <ListGroup style={[styles.group, styles.cancelGroup]}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Cancel">
            {({ pressed }) => (
              <View
                style={[
                  styles.cancel,
                  pressed && styles.pressed,
                  pressed ? pressTransition.pressed : pressTransition.rest
                ]}
              >
                <Text style={styles.cancelLabel}>Cancel</Text>
              </View>
            )}
          </Pressable>
        </ListGroup>
      ) : null}
    </View>
  )
}

function ActionRow({ action, onClose }: { action: ActionSheetAction; onClose?: () => void }) {
  const Icon = iconForAction(action.label, action.destructive, action.icon)
  const customIcon = action.renderIcon?.()
  const inert = action.disabled === true || action.loading === true
  const tint = action.destructive ? colors.danger : colors.textSecondary
  return (
    <Pressable
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityHint={action.hint}
      accessibilityState={{ disabled: inert, busy: action.loading === true }}
      onPress={() => {
        action.onPress()
        if (!action.skipAutoClose && onClose) {
          onClose()
        }
      }}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.row,
            action.hint ? styles.rowTwoLine : null,
            pressed && !inert && styles.pressed,
            action.disabled && styles.disabled,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          <View style={styles.leading}>
            {customIcon ?? <Icon size={20} color={tint} strokeWidth={2} />}
          </View>
          <View style={styles.main}>
            <Text
              style={[styles.label, action.destructive && styles.labelDestructive]}
              numberOfLines={1}
            >
              {action.label}
            </Text>
            {action.hint ? (
              <Text style={styles.hint} numberOfLines={2}>
                {action.hint}
              </Text>
            ) : null}
          </View>
          {action.loading ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
        </View>
      )}
    </Pressable>
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
  root: { gap: spacing.sm },
  header: {
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm
  },
  title: {
    ...textStyles.footnote,
    fontWeight: '600',
    color: colors.textSecondary,
    textAlign: 'center'
  },
  message: { ...textStyles.footnote, color: colors.textMuted, textAlign: 'center' },
  // Why: the sheet already pads 12; the group adds 4 so rows sit 16 from the sheet edge.
  group: { marginHorizontal: spacing.xs },
  cancelGroup: { marginTop: spacing.xs },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: 10
  },
  rowTwoLine: { minHeight: 64 },
  pressed: { backgroundColor: colors.fill },
  disabled: { opacity: motion.disabledOpacity },
  leading: { width: 28, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  main: { flex: 1, minWidth: 0, gap: 2 },
  label: { ...textStyles.body, color: colors.textPrimary },
  labelDestructive: { color: colors.danger },
  hint: { ...textStyles.subhead, color: colors.textSecondary },
  cancel: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: LIST_ROW_PADDING
  },
  cancelLabel: { ...textStyles.body, fontWeight: '600', color: colors.textPrimary }
})
