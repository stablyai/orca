import { useRef, type ReactNode } from 'react'
import { ActivityIndicator, View, Text } from 'react-native'
import { Edit3, Trash2, type LucideIcon } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { BottomDrawer } from './BottomDrawer'
import { LIST_LEADING_INSET, LIST_ROW_PADDING, ListGroup, ListRow } from './list/ListGroup'

export type ActionSheetAction = {
  id?: string
  label: string
  icon?: LucideIcon
  renderIcon?: () => ReactNode
  destructive?: boolean
  disabled?: boolean
  hint?: string
  /** Marks the choice that is current, as a trailing check. */
  checked?: boolean
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
  /** Drawn between the header and the actions. */
  children?: ReactNode
  actions: ActionSheetAction[]
  onClose?: () => void
}

export function ActionSheetContent({ title, message, children, actions, onClose }: ContentProps) {
  useMobileColorScheme()
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

      {children}

      <ListGroup separatorInset={LIST_LEADING_INSET}>
        {actions.map((action) => {
          const Icon = iconForAction(action.label, action.destructive, action.icon)
          return (
            <ListRow
              key={action.id ?? action.label}
              title={action.label}
              subtitle={action.hint}
              leading={
                action.renderIcon?.() ?? (
                  <Icon
                    size={16}
                    color={action.destructive ? colors.statusRed : colors.textSecondary}
                  />
                )
              }
              accessory={
                action.loading ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : undefined
              }
              selected={action.checked ? true : undefined}
              destructive={action.destructive}
              disabled={action.disabled}
              busy={action.loading}
              onPress={() => {
                action.onPress()
                if (!action.skipAutoClose && onClose) {
                  onClose()
                }
              }}
            />
          )
        })}
      </ListGroup>
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
        // Wait for iOS sheet window to unmount before presenting another native modal.
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

const styles = themedStyleSheet(() => ({
  header: {
    paddingHorizontal: LIST_ROW_PADDING,
    paddingBottom: spacing.sm
  },
  title: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary
  },
  message: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginTop: 2
  }
}))
