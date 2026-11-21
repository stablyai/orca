import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronLeft, X } from '../icons/app-icons'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, feedback, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { NavBarButton } from './NavBarButton'
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
  /** "Done" or the sheet's commit, in bold. */
  trailing?: SheetTextAction
  /** A close button instead of a text action, for sheets that only show things. */
  onClose?: () => void
  /** Up to two NavBarButtons instead of a trailing text action, for a sheet whose actions are icons. */
  trailingButtons?: ReactNode
}

// The one sheet header: a centred title, with a text action or a round button on either side.
export function SheetHeader({
  title,
  subtitle,
  leading,
  onBack,
  trailing,
  onClose,
  trailingButtons,
  titleAboveActions
}: SheetHeaderProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  useSheetPageTop(title)
  return (
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
        <View style={styles.side}>
          {leading ? (
            <TextAction action={leading} emphasis={false} />
          ) : onBack ? (
            <NavBarButton
              icon={ChevronLeft}
              accessibilityLabel={onBack.label}
              onPress={onBack.onPress}
            />
          ) : null}
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
        <View style={[styles.side, styles.trailing]}>
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
  )
}

function TextAction({ action, emphasis }: { action: SheetTextAction; emphasis: boolean }) {
  useMobileColorScheme()
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

const styles = themedStyleSheet(() => ({
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
