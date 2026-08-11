import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import {
  BUILTIN_TERMINAL_THEME_NAMES,
  getBuiltinTerminalThemePalette
} from '../../../src/shared/terminal-themes'
import type { TerminalColorOverrides } from '../../../src/shared/types'
import { PickerListDrawer } from '../components/PickerListDrawer'
import {
  getMobileTerminalThemeSelection,
  loadMobileTerminalThemeSelection,
  saveMobileTerminalThemeSelection,
  subscribeMobileTerminalThemeSelection,
  type MobileTerminalThemeSelection
} from '../storage/terminal-theme-preference'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export type TerminalThemeSlot = 'dark' | 'light'

export type TerminalThemePickerItem = {
  id: string
  label: string
  palette: TerminalColorOverrides | null
}

// Why: storage records "follow desktop" as an absent key, so this row id is
// UI-only and must never reach AsyncStorage.
const FOLLOW_DESKTOP_ITEM_ID = '__follow-desktop__'
const FOLLOW_DESKTOP_LABEL = 'Follow desktop'

export const TERMINAL_THEME_PICKER_ITEMS: TerminalThemePickerItem[] = [
  { id: FOLLOW_DESKTOP_ITEM_ID, label: FOLLOW_DESKTOP_LABEL, palette: null },
  ...BUILTIN_TERMINAL_THEME_NAMES.map((name) => ({
    id: name,
    label: name,
    palette: getBuiltinTerminalThemePalette(name)
  }))
]

function slotPalette(name: string | null): TerminalColorOverrides | null {
  return name ? getBuiltinTerminalThemePalette(name) : null
}

/** The theme's own colors, so a row is readable without opening the terminal. */
export function TerminalThemeSwatch({
  palette
}: {
  palette: TerminalColorOverrides | null
}): React.JSX.Element {
  return (
    <View
      style={[styles.swatch, { backgroundColor: palette?.background ?? colors.bgRaised }]}
      // Why: without both, VoiceOver/TalkBack reads the literal "Aa" on all 31 rows.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.swatchGlyph, { color: palette?.foreground ?? colors.textMuted }]}>
        Aa
      </Text>
      {palette ? (
        <View style={styles.swatchDots}>
          <View style={[styles.swatchDot, { backgroundColor: palette.red }]} />
          <View style={[styles.swatchDot, { backgroundColor: palette.green }]} />
          <View style={[styles.swatchDot, { backgroundColor: palette.blue }]} />
        </View>
      ) : null}
    </View>
  )
}

const renderThemeSwatch = (item: TerminalThemePickerItem): React.JSX.Element => (
  <TerminalThemeSwatch palette={item.palette} />
)

function SlotRow({
  label,
  sublabel,
  palette,
  disabled,
  onPress
}: {
  label: string
  sublabel: string
  palette: TerminalColorOverrides | null
  disabled: boolean
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        pressed && !disabled && styles.rowPressed,
        disabled && styles.rowDisabled
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${sublabel}`}
      accessibilityState={{ disabled }}
    >
      <TerminalThemeSwatch palette={palette} />
      <View style={styles.rowContent}>
        <Text style={styles.rowLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.rowSublabel} numberOfLines={1}>
          {sublabel}
        </Text>
      </View>
      <ChevronRight size={16} color={colors.textMuted} />
    </Pressable>
  )
}

function useTerminalThemeSelection(): MobileTerminalThemeSelection {
  const selection = useSyncExternalStore(
    subscribeMobileTerminalThemeSelection,
    getMobileTerminalThemeSelection
  )
  useEffect(() => {
    void loadMobileTerminalThemeSelection()
  }, [])
  return selection
}

export function TerminalThemeSettings({
  onOpenSlot
}: {
  onOpenSlot: (slot: TerminalThemeSlot) => void
}): React.JSX.Element {
  const selection = useTerminalThemeSelection()
  const matchDarkMode = !selection.useSeparateLightTheme
  const toggleMatchDarkMode = useCallback((checked: boolean) => {
    // Why: the stored setting is the inverse of the concept the row exposes.
    void saveMobileTerminalThemeSelection({ useSeparateLightTheme: !checked })
  }, [])

  return (
    <>
      <Text style={[styles.groupHeading, styles.groupTopGap]}>THEME</Text>
      <Text style={styles.groupDescription}>
        Choose the terminal color theme used in dark and light mode. Follow desktop uses whatever
        theme your paired desktop sends. Per-device display only; doesn&apos;t change the desktop
        terminal.
      </Text>
      <View style={[styles.section, styles.sectionTopGap]}>
        <SlotRow
          label="Dark theme"
          sublabel={selection.dark ?? FOLLOW_DESKTOP_LABEL}
          palette={slotPalette(selection.dark)}
          disabled={false}
          onPress={() => onOpenSlot('dark')}
        />
        <View style={styles.separator} />
        <View style={styles.row}>
          <View style={styles.rowContent}>
            <Text style={styles.rowLabel}>Match dark mode</Text>
            <Text style={styles.rowSublabel}>Share the dark terminal theme in light mode.</Text>
          </View>
          <Switch
            value={matchDarkMode}
            onValueChange={toggleMatchDarkMode}
            // Why: RN does not associate the sibling Text, so without this the
            // switch announces only "off, switch".
            accessibilityLabel="Match dark mode"
            trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
            thumbColor={colors.textPrimary}
          />
        </View>
        <View style={styles.separator} />
        <SlotRow
          label="Light theme"
          sublabel={
            matchDarkMode ? 'Same as dark theme' : (selection.light ?? FOLLOW_DESKTOP_LABEL)
          }
          palette={matchDarkMode ? null : slotPalette(selection.light)}
          disabled={matchDarkMode}
          onPress={() => onOpenSlot('light')}
        />
      </View>
    </>
  )
}

/** Rendered at screen root: a drawer inside the ScrollView clips its backdrop. */
export function TerminalThemePickerDrawer({
  slot,
  onClose
}: {
  slot: TerminalThemeSlot | null
  onClose: () => void
}): React.JSX.Element {
  const selection = useTerminalThemeSelection()
  const selected = slot === 'light' ? selection.light : selection.dark
  // Why: PickerListDrawer defers onSelect past its close animation, so the slot
  // this closure captured at press time is the one that must be written.
  const handleSelect = useCallback(
    (item: TerminalThemePickerItem) => {
      const name = item.id === FOLLOW_DESKTOP_ITEM_ID ? null : item.id
      void saveMobileTerminalThemeSelection(slot === 'light' ? { light: name } : { dark: name })
    },
    [slot]
  )

  return (
    <PickerListDrawer<TerminalThemePickerItem>
      visible={slot != null}
      title={slot === 'light' ? 'Light theme' : slot === 'dark' ? 'Dark theme' : ''}
      items={TERMINAL_THEME_PICKER_ITEMS}
      selectedId={selected ?? FOLLOW_DESKTOP_ITEM_ID}
      onSelect={handleSelect}
      onClose={onClose}
      renderIcon={renderThemeSwatch}
    />
  )
}

const styles = StyleSheet.create({
  groupHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  groupTopGap: {
    marginTop: spacing.xl
  },
  groupDescription: {
    fontSize: typography.bodySize - 1,
    color: colors.textSecondary,
    lineHeight: 20,
    paddingHorizontal: spacing.xs
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden'
  },
  sectionTopGap: {
    marginTop: spacing.sm
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowDisabled: {
    opacity: 0.45
  },
  rowContent: {
    flex: 1
  },
  rowLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rowSublabel: {
    fontSize: typography.bodySize - 2,
    color: colors.textSecondary,
    marginTop: 2
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  swatch: {
    width: 56,
    height: 30,
    borderRadius: radii.button,
    // Why: a near-bgPanel theme would otherwise vanish into the row.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center'
  },
  swatchGlyph: {
    fontSize: 12,
    fontWeight: '600'
  },
  swatchDots: {
    flexDirection: 'row',
    gap: 3,
    marginTop: 2
  },
  swatchDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5
  }
})
