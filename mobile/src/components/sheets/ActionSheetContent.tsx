import type { ReactNode } from 'react'
import { ActivityIndicator, View, Text } from 'react-native'
import { Edit3, Trash2, type AppIcon } from '../icons/app-icons'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { LIST_LEADING_INSET, LIST_ROW_PADDING, ListGroup, ListRow } from '../list/ListGroup'

export type ActionSheetAction = {
  id?: string
  label: string
  icon?: AppIcon
  renderIcon?: () => ReactNode
  destructive?: boolean
  disabled?: boolean
  hint?: string
  /** Short trailing state, e.g. "↑2" or "Up to date". */
  status?: string
  /** Marks the choice that is current, as a trailing check. */
  checked?: boolean
  loading?: boolean
  skipAutoClose?: boolean
  closeBeforePress?: boolean
  onPress: () => void
}

export type ActionSheetModalProps = {
  visible: boolean
  /** Text, or Text-compatible nodes such as a marked name. */
  title?: ReactNode
  /** What a screen reader hears for a title that is not plain text. */
  titleAccessibilityLabel?: string
  message?: string
  actions: ActionSheetAction[]
  onClose: () => void
  /** Runs once the sheet has slid away, after any closeBeforePress action. */
  onAfterClose?: () => void
}

function iconForAction(label: string, destructive?: boolean, icon?: AppIcon): AppIcon {
  if (icon) {
    return icon
  }
  if (destructive || /delete|remove/i.test(label)) {
    return Trash2
  }
  return Edit3
}

type ContentProps = {
  title?: ReactNode
  titleAccessibilityLabel?: string
  message?: string
  /** Drawn between the header and the actions. */
  children?: ReactNode
  actions: ActionSheetAction[]
  onClose?: () => void
}

export function ActionSheetContent({
  title,
  titleAccessibilityLabel,
  message,
  children,
  actions,
  onClose
}: ContentProps) {
  useMobileColorScheme()
  return (
    <>
      {(title || message) && (
        <View style={styles.header}>
          {title ? (
            <Text
              style={styles.title}
              numberOfLines={1}
              accessibilityLabel={titleAccessibilityLabel}
            >
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
              value={action.status}
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
