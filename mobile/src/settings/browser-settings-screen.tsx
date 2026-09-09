import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, ChevronRight, Globe } from 'lucide-react-native'
import { PickerModal, type PickerOption } from '../components/PickerModal'
import {
  loadTerminalLinkOpenMode,
  saveTerminalLinkOpenMode,
  type MobileTerminalLinkOpenMode
} from '../storage/preferences'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

const LINK_MODE_OPTIONS: PickerOption<MobileTerminalLinkOpenMode>[] = [
  {
    value: 'orca-browser',
    label: 'Orca browser on desktop',
    subtitle: 'Open in the streamed browser from your paired desktop.'
  },
  {
    value: 'phone-browser',
    label: 'Phone browser',
    subtitle: 'Open in Safari, Chrome, or another browser on this phone.'
  }
]

function linkModeLabel(mode: MobileTerminalLinkOpenMode): string {
  return (
    LINK_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? LINK_MODE_OPTIONS[0]!.label
  )
}

export default function BrowserSettingsScreen({
  onBack,
  scope = 'device',
  available = true,
  loadLinkMode = loadTerminalLinkOpenMode
}: {
  onBack?: () => void
  scope?: 'device' | 'host'
  available?: boolean
  loadLinkMode?: () => Promise<MobileTerminalLinkOpenMode>
}): React.JSX.Element {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [linkMode, setLinkMode] = useState<MobileTerminalLinkOpenMode>('orca-browser')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void loadLinkMode().then(
      (mode) => {
        if (active) {
          setLinkMode(mode)
          setBusy(false)
        }
      },
      () => {
        if (active) {
          setError('Could not load browser preferences. Go back and try again.')
        }
      }
    )
    return () => {
      active = false
    }
  }, [loadLinkMode])

  const selectLinkMode = useCallback((mode: MobileTerminalLinkOpenMode) => {
    setBusy(true)
    setError(null)
    void saveTerminalLinkOpenMode(mode)
      .then(
        () => setLinkMode(mode),
        () => setError('Could not save browser preferences. Try again.')
      )
      .finally(() => setBusy(false))
  }, [])

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backButton}
          onPress={onBack ?? (() => router.back())}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Browser</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.groupHeading}>LINKS</Text>
        <Text style={styles.groupDescription}>
          Choose where HTTP(S) links tapped in terminal output open
          {scope === 'host' ? ' for this paired host' : ''}.
        </Text>
        {!available && (
          <Text accessibilityRole="alert" style={styles.groupDescription}>
            Browser preferences are not available in this app version.
          </Text>
        )}
        {error && (
          <Text accessibilityRole="alert" style={styles.groupDescription}>
            {error}
          </Text>
        )}
        <View style={[styles.section, styles.sectionTopGap]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open terminal links"
            disabled={!available || busy}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setPickerOpen(true)}
          >
            <Globe size={16} color={colors.textSecondary} />
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Open terminal links</Text>
              <Text style={styles.rowSublabel}>{linkModeLabel(linkMode)}</Text>
            </View>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
        </View>
      </ScrollView>

      <PickerModal<MobileTerminalLinkOpenMode>
        visible={pickerOpen}
        title="Open terminal links"
        options={LINK_MODE_OPTIONS}
        selected={linkMode}
        onSelect={selectLinkMode}
        onClose={() => setPickerOpen(false)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg,
    paddingTop: 0
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.lg
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
  scrollContent: {
    paddingBottom: spacing.xl
  },
  groupHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs
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
  }
})
