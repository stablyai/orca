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
  LifeBuoy
} from 'lucide-react-native'
import { colors, spacing, typography } from '../src/theme/mobile-theme'

export default function SettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()

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
    </View>
  )
}

const styles = StyleSheet.create({
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
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  }
})
