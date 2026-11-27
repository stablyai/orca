import { Fragment, isValidElement, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronLeft, X } from 'lucide-react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { feedback, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { NAV_BAR_BUTTON_SIZE, NavBarButton, NavBarButtonOnSheetContext } from './NavBarButton'
import { useSheetPageTop } from './sheet-page-scroll'

type SheetTextAction = { label: string; onPress: () => void; disabled?: boolean; busy?: boolean }

type SheetHeaderProps = {
  title: string
  titleAboveActions?: boolean
  subtitle?: string
  /** "Cancel" or "Reset"; omit for a plain list sheet. */
  leading?: SheetTextAction
  /** A back chevron instead of a leading text action, on a page pushed inside the sheet. */
  onBack?: { label: string; onPress: () => void }
  /** One NavBarButton in the leading slot, for a sheet with no back or text action there. */
  leadingButton?: ReactNode
  /** "Done" or the sheet's commit, in bold. */
  trailing?: SheetTextAction
  /** A close button instead of a text action, for sheets that only show things. */
  onClose?: () => void
  /** Up to two NavBarButtons instead of a trailing text action, for a sheet whose actions are icons. */
  trailingButtons?: ReactNode
}

/** A single round button, not a fragment of two. */
function oneButton(node: ReactNode): boolean {
  return isValidElement(node) && node.type !== Fragment
}

// The one sheet header: a centred title, with a text action or a round button on either side.
export function SheetHeader({
  title,
  subtitle,
  leading,
  onBack,
  leadingButton,
  trailing,
  onClose,
  trailingButtons,
  titleAboveActions
}: SheetHeaderProps) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  useSheetPageTop(title)
  // Sides as narrow as one round button when that's all either holds, so the title gets the room.
  const narrow =
    !leading &&
    !trailing &&
    (leadingButton === undefined || oneButton(leadingButton)) &&
    (trailingButtons === undefined || oneButton(trailingButtons))
  const side = [styles.side, narrow && styles.sideNarrow]
  return (
    <NavBarButtonOnSheetContext value={true}>
      <View>
        {titleAboveActions ? (
          <View style={styles.heading}>
            <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
              {title}
            </Text>
            {subtitle !== undefined ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        ) : null}
        <View style={styles.header}>
          <View style={side}>
            {leading ? (
              <TextAction action={leading} emphasis={false} />
            ) : onBack ? (
              <NavBarButton
                icon={ChevronLeft}
                accessibilityLabel={onBack.label}
                onPress={onBack.onPress}
              />
            ) : (
              (leadingButton ?? null)
            )}
          </View>
          {!titleAboveActions ? (
            <View style={styles.center}>
              {title ? (
                <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
                  {title}
                </Text>
              ) : null}
              {subtitle !== undefined ? (
                <Text style={styles.subtitle} numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          ) : (
            <View style={styles.center} />
          )}
          <View style={[...side, styles.trailing]}>
            {trailing ? <TextAction action={trailing} emphasis /> : (trailingButtons ?? null)}
            {onClose && !trailing && !trailingButtons ? (
              <NavBarButton
                icon={X}
                accessibilityLabel={t('components.sheetHeader.close', 'Close')}
                onPress={onClose}
              />
            ) : null}
          </View>
        </View>
      </View>
    </NavBarButtonOnSheetContext>
  )
}

function TextAction({ action, emphasis }: { action: SheetTextAction; emphasis: boolean }) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  return (
    <Pressable
      onPress={action.onPress}
      disabled={action.disabled || action.busy}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled: action.disabled === true, busy: action.busy === true }}
      style={({ pressed }) => [
        styles.action,
        pressed && styles.actionPressed,
        action.disabled && styles.actionDisabled
      ]}
    >
      {action.busy ? (
        <ActivityIndicator size="small" color={colors.textPrimary} />
      ) : (
        <Text style={[styles.actionLabel, emphasis && styles.actionEmphasis]} numberOfLines={1}>
          {action.label}
        </Text>
      )}
    </Pressable>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  heading: { alignItems: 'center', paddingTop: spacing.sm, paddingHorizontal: spacing.md },
  header: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs
  },
  side: {
    width: 84,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sideNarrow: { width: NAV_BAR_BUTTON_SIZE + spacing.sm },
  trailing: {
    justifyContent: 'flex-end'
  },
  center: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center'
  },
  title: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '600'
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 12
  },
  action: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    justifyContent: 'center'
  },
  // bgRaised is the light sheet's own color; the translucent fill reads on both themes.
  actionPressed: {
    backgroundColor: colors.translucentFill
  },
  actionDisabled: {
    opacity: feedback.disabledOpacity
  },
  actionLabel: {
    color: colors.textPrimary,
    fontSize: 16
  },
  actionEmphasis: {
    fontWeight: '600'
  }
}))
