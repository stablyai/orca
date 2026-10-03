import { useCallback, useEffect, useRef, useState } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Check, ChevronLeft } from 'lucide-react-native'
import { APP_ICON_OPTIONS, DEFAULT_APP_ICON_ID, type AppIconId } from '../../../src/shared/app-icon'
import { loadAppIcon, saveAppIcon } from '../app-icon/app-icon-switcher'
import { APP_ICON_PREVIEW_ASSETS } from '../app-icon/app-icon-preview-assets'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export default function AppIconSettingsScreen({
  onBack
}: {
  onBack?: () => void
}): React.JSX.Element {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [iconId, setIconId] = useState<AppIconId>(DEFAULT_APP_ICON_ID)
  const [supported, setSupported] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Why: only the latest tap may decide the checkmark; older reads and changes are stale.
  const latestRequest = useRef(0)
  // Why: iOS rejects an icon change while another is in flight, so changes run one at a time.
  const pendingChange = useRef(Promise.resolve())

  useEffect(() => {
    let active = true
    void loadAppIcon().then(
      (loaded) => {
        if (!active) {
          return
        }
        setSupported(loaded.supported)
        if (latestRequest.current === 0) {
          setIconId(loaded.iconId)
        }
      },
      () => {
        if (active) {
          setError('Could not read the current app icon. Try again.')
        }
      }
    )
    return () => {
      active = false
    }
  }, [])

  const selectIcon = useCallback(
    (next: AppIconId) => {
      if (next === iconId) {
        return
      }
      const previous = iconId
      const request = ++latestRequest.current
      const isLatest = () => request === latestRequest.current
      setError(null)
      setIconId(next)
      pendingChange.current = pendingChange.current.then(async () => {
        if (!isLatest()) {
          return
        }
        try {
          await saveAppIcon(next)
        } catch {
          if (!isLatest()) {
            return
          }
          setError('Could not change the app icon. Try again.')
          // The OS knows which icon is actually in place; if it can't say, the change didn't apply.
          const loaded = await loadAppIcon().catch(() => null)
          if (isLatest()) {
            setIconId(loaded?.iconId ?? previous)
          }
        }
      })
    },
    [iconId]
  )

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
        <Text style={styles.heading}>App Icon</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.groupHeading}>APP ICON</Text>
        <Text style={styles.groupDescription}>
          {supported
            ? 'Choose the icon shown on your home screen.'
            : 'This device does not support changing the app icon.'}
        </Text>
        {error && (
          <Text accessibilityRole="alert" style={styles.groupDescription}>
            {error}
          </Text>
        )}
        <View style={[styles.section, styles.sectionTopGap]}>
          {APP_ICON_OPTIONS.map((option, index) => {
            const selected = option.id === iconId
            return (
              <View key={option.id}>
                {index > 0 && <View style={styles.separator} />}
                <Pressable
                  accessibilityRole="radio"
                  accessibilityLabel={option.label}
                  accessibilityState={{ checked: selected, disabled: !supported }}
                  disabled={!supported}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  onPress={() => selectIcon(option.id)}
                >
                  <Image source={APP_ICON_PREVIEW_ASSETS[option.id]} style={styles.preview} />
                  <Text style={styles.rowLabel}>{option.label}</Text>
                  {selected && <Check size={18} color={colors.textPrimary} />}
                </Pressable>
              </View>
            )
          })}
        </View>
      </ScrollView>
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
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  preview: {
    width: 44,
    height: 44,
    // iOS home-screen corner ratio (~22.5% of the side).
    borderRadius: 10
  },
  rowLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  }
})
