import { useRef, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, View, Text } from 'react-native'
import { Edit3, Trash2, type LucideIcon } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { BottomDrawer } from '../bottom-drawer/BottomDrawer'
import { LIST_LEADING_INSET, LIST_ROW_PADDING, ListGroup, ListRow } from '../list/ListGroup'

export type ActionSheetAction = {
  id?: string
  label: string
  icon?: LucideIcon
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

type Props = {
  visible: boolean
  /** Text, or Text-compatible nodes such as a marked name. */
  title?: ReactNode
  /** What a screen reader hears for a title that is not plain text. */
  titleAccessibilityLabel?: string
  message?: string
  /** Names the subject with its icon: drawn in a tile, with the title large and the message under it. */
  headerIcon?: ReactNode
  /** Puts destructive actions in their own group below the rest. */
  groupDestructive?: boolean
  actions: ActionSheetAction[]
  /** A centred Cancel row in its own group, for a question that must offer a way out. */
  cancelLabel?: string
  onClose: () => void
  /** Runs once the sheet has slid away, after any closeBeforePress action. */
  onAfterClose?: () => void
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
  title?: ReactNode
  titleAccessibilityLabel?: string
  message?: string
  headerIcon?: ReactNode
  groupDestructive?: boolean
  /** Drawn between the header and the actions. */
  children?: ReactNode
  actions: ActionSheetAction[]
  cancelLabel?: string
  onClose?: () => void
}

export function ActionSheetContent({
  title,
  titleAccessibilityLabel,
  message,
  headerIcon,
  groupDestructive = false,
  children,
  actions,
  cancelLabel,
  onClose
}: ContentProps) {
  useMobileColorScheme()
  const groups = (
    groupDestructive
      ? [
          { key: 'actions', actions: actions.filter((action) => !action.destructive) },
          { key: 'destructive', actions: actions.filter((action) => action.destructive) }
        ]
      : [{ key: 'actions', actions }]
  ).filter((group) => group.actions.length > 0)
  return (
    <>
      {headerIcon ? (
        <View style={[styles.header, styles.subjectHeader]}>
          <View style={styles.subjectTile}>{headerIcon}</View>
          <View style={styles.subjectText}>
            {title ? (
              <Text
                style={styles.subjectTitle}
                numberOfLines={1}
                accessibilityRole="header"
                accessibilityLabel={titleAccessibilityLabel}
              >
                {title}
              </Text>
            ) : null}
            {message ? (
              <Text style={styles.subjectMessage} numberOfLines={1}>
                {message}
              </Text>
            ) : null}
          </View>
        </View>
      ) : (
        (title || message) && (
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
        )
      )}

      {children}

      {groups.map((group, index) => (
        <ListGroup
          key={group.key}
          separatorInset={LIST_LEADING_INSET}
          style={index > 0 ? styles.laterGroup : undefined}
        >
          {group.actions.map((action) => {
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
      ))}
      {cancelLabel && onClose ? (
        <ListGroup style={groups.length > 0 ? styles.laterGroup : undefined}>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.cancelRow, pressed && styles.cancelPressed]}
          >
            <Text style={styles.cancelLabel}>{cancelLabel}</Text>
          </Pressable>
        </ListGroup>
      ) : null}
    </>
  )
}

export function ActionSheetModal({
  visible,
  title,
  titleAccessibilityLabel,
  message,
  headerIcon,
  groupDestructive,
  actions,
  cancelLabel,
  onClose,
  onAfterClose
}: Props) {
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
        onAfterClose?.()
      }}
      dragContentToDismiss
    >
      <ActionSheetContent
        title={title}
        titleAccessibilityLabel={titleAccessibilityLabel}
        message={message}
        headerIcon={headerIcon}
        groupDestructive={groupDestructive}
        actions={sequencedActions}
        cancelLabel={cancelLabel}
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
  },
  subjectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingBottom: spacing.md
  },
  subjectTile: {
    width: 34,
    height: 34,
    borderRadius: radii.tile,
    backgroundColor: colors.translucentFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  subjectText: { flex: 1, minWidth: 0, gap: 2 },
  subjectTitle: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  subjectMessage: { fontSize: 13, color: colors.textSecondary },
  laterGroup: { marginTop: spacing.md },
  // A ListRow's 48 pt and 15 pt title, centred: the row answers the sheet rather than naming a thing.
  cancelRow: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  cancelPressed: { backgroundColor: colors.translucentFill },
  cancelLabel: { fontSize: 15, color: colors.textPrimary }
}))
