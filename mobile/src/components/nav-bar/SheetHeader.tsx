import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { NavBarButton } from './NavBarButton'

type SheetTextAction = { label: string; onPress: () => void; disabled?: boolean; busy?: boolean }

type SheetHeaderProps = {
  title: string
  subtitle?: string
  /** "Cancel" or "Reset"; omit for a plain list sheet. */
  leading?: SheetTextAction
  /** "Done" or the sheet's commit, in bold. */
  trailing?: SheetTextAction
  /** A close button instead of a text action, for sheets that only show things. */
  onClose?: () => void
}

// The one sheet header: a centred title, with a text action or close button on either side.
export function SheetHeader({ title, subtitle, leading, trailing, onClose }: SheetHeaderProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.header}>
      <View style={styles.side}>
        {leading ? <TextAction action={leading} emphasis={false} /> : null}
      </View>
      <View style={styles.center}>
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        {subtitle !== undefined ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={[styles.side, styles.trailing]}>
        {trailing ? <TextAction action={trailing} emphasis /> : null}
        {onClose && !trailing ? (
          <NavBarButton
            icon={X}
            accessibilityLabel={t('components.sheetHeader.close', 'Close')}
            onPress={onClose}
          />
        ) : null}
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
  header: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs
  },
  side: {
    width: 84,
    flexDirection: 'row',
    alignItems: 'center'
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
  actionPressed: {
    backgroundColor: colors.bgRaised
  },
  actionDisabled: {
    opacity: 0.4
  },
  actionLabel: {
    color: colors.textPrimary,
    fontSize: 16
  },
  actionEmphasis: {
    fontWeight: '600'
  }
}))
