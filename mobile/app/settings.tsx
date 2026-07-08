import { useCallback, useState } from 'react'
import { View, Text, StyleSheet, Pressable, Linking } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import {
  ChevronLeft,
  ChevronRight,
  Info,
  Bell,
  Wrench,
  Shield,
  LifeBuoy,
  Mic,
  Globe,
  SunMoon,
  Terminal as TerminalIcon
} from 'lucide-react-native'
import { spacing, typography, type ThemeColors } from '../src/theme/mobile-theme'
import { useTheme, useThemedStyles, type ThemePreference } from '../src/theme/theme-context'
import { PickerModal, type PickerOption } from '../src/components/PickerModal'

const APPEARANCE_OPTIONS: PickerOption<ThemePreference>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

function appearanceLabel(preference: ThemePreference): string {
  return APPEARANCE_OPTIONS.find((option) => option.value === preference)?.label ?? 'Dark'
}

export default function SettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { colors, preference, setPreference } = useTheme()
  const styles = useThemedStyles(createStyles)
  const [appearancePickerOpen, setAppearancePickerOpen] = useState(false)
  const selectAppearance = useCallback(
    (nextPreference: ThemePreference) => setPreference(nextPreference),
    [setPreference]
  )

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Settings</Text>
      </View>

      <View style={styles.section}>
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => setAppearancePickerOpen(true)}
        >
          <SunMoon size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Appearance</Text>
          <Text style={styles.rowValue}>{appearanceLabel(preference)}</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
        <View style={styles.separator} />
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => router.push('/terminal-settings')}
        >
          <TerminalIcon size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Terminal</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
        <View style={styles.separator} />
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => router.push('/browser-settings')}
        >
          <Globe size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Browser</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
        <View style={styles.separator} />
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => router.push('/voice-settings')}
        >
          <Mic size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Voice</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
        <View style={styles.separator} />
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => router.push('/notifications')}
        >
          <Bell size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Notifications</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
        <View style={styles.separator} />
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => router.push('/troubleshoot')}
        >
          <Wrench size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Troubleshooting</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
        <View style={styles.separator} />
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => router.push('/about')}
        >
          <Info size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>About</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
      </View>

      <View style={[styles.section, styles.sectionSpacer]}>
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => void Linking.openURL('https://www.onorca.dev/privacy')}
        >
          <Shield size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Privacy Policy</Text>
        </Pressable>
        <View style={styles.separator} />
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => void Linking.openURL('https://github.com/stablyai/orca/issues')}
        >
          <LifeBuoy size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Support</Text>
        </Pressable>
      </View>

      <PickerModal<ThemePreference>
        visible={appearancePickerOpen}
        title="Appearance"
        options={APPEARANCE_OPTIONS}
        selected={preference}
        onSelect={selectAppearance}
        onClose={() => setAppearancePickerOpen(false)}
      />
    </View>
  )
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.bgBase,
      padding: spacing.lg
    },
    topRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: spacing.xl
    },
    backButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: spacing.sm
    },
    heading: {
      fontSize: 20,
      fontWeight: '700',
      color: colors.textPrimary
    },
    section: {
      backgroundColor: colors.bgPanel,
      borderRadius: 12,
      overflow: 'hidden'
    },
    sectionSpacer: {
      marginTop: spacing.md
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
    rowLabel: {
      flex: 1,
      fontSize: typography.bodySize,
      fontWeight: '500',
      color: colors.textPrimary
    },
    rowValue: {
      fontSize: typography.bodySize - 2,
      color: colors.textSecondary
    },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.borderSubtle,
      marginHorizontal: spacing.md
    }
  })
