import type { ComponentType } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronUp, X } from 'lucide-react-native'
import { MobileSearchField } from '../../../components/controls/MobileSearchField'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, feedback, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import type { TerminalFindResults } from '../../webview/terminal-webview-contract'
import type { MobileTerminalFind } from './use-mobile-terminal-find'

const ICON_SIZE = 18

type IconProps = { size?: number; color?: string }

// Same reading as desktop terminal search: n/m, or m+ past xterm's highlight limit.
export function terminalFindCount(query: string, results: TerminalFindResults): string | null {
  if (!query || results.resultCount === 0) {
    return null
  }
  return results.resultIndex === -1
    ? `${results.resultCount}+`
    : `${results.resultIndex + 1}/${results.resultCount}`
}

function FindBarButton({
  icon: Icon,
  label,
  disabled,
  onPress
}: {
  icon: ComponentType<IconProps>
  label: string
  disabled?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        disabled && styles.buttonDisabled,
        pressed && styles.buttonPressed
      ]}
    >
      <Icon size={ICON_SIZE} color={colors.textPrimary} />
    </Pressable>
  )
}

export function MobileTerminalFindBar({ find }: { find: MobileTerminalFind }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const count = terminalFindCount(find.query, find.results)
  const noMatches = find.query.length > 0 && find.results.resultCount === 0
  const navigationDisabled = find.results.resultCount === 0
  return (
    <View style={styles.bar}>
      <MobileSearchField
        value={find.query}
        onChangeText={find.setQuery}
        placeholder={t('session.terminalFind.placeholder', 'Find in terminal')}
        autoFocus
        focusKey={find.focusKey}
        onSubmitEditing={find.findNext}
        style={styles.field}
      />
      {count !== null || noMatches ? (
        <Text style={styles.count} accessibilityLiveRegion="polite" numberOfLines={1}>
          {noMatches ? t('session.terminalFind.noResults', 'No results') : count}
        </Text>
      ) : null}
      <FindBarButton
        icon={ChevronUp}
        label={t('session.terminalFind.previous', 'Previous match')}
        disabled={navigationDisabled}
        onPress={find.findPrevious}
      />
      <FindBarButton
        icon={ChevronDown}
        label={t('session.terminalFind.next', 'Next match')}
        disabled={navigationDisabled}
        onPress={find.findNext}
      />
      <FindBarButton
        icon={X}
        label={t('session.terminalFind.close', 'Close find')}
        onPress={find.closeFind}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    padding: spacing.xs,
    borderRadius: radii.surface,
    borderWidth: 1,
    borderColor: colors.floatingCardBorder,
    backgroundColor: colors.bgPanel
  },
  field: { flex: 1, minWidth: 0 },
  count: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontVariant: ['tabular-nums'],
    paddingHorizontal: spacing.xs
  },
  button: {
    width: 36,
    height: 36,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonPressed: { backgroundColor: colors.translucentFill },
  buttonDisabled: { opacity: feedback.disabledOpacity }
}))
