import { useState } from 'react'
import { Image, Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Check, ChevronLeft } from 'lucide-react-native'
import {
  getAppIconName,
  setAlternateAppIcon,
  supportsAlternateIcons
} from 'expo-alternate-app-icons'
import { APP_ICON_OPTIONS, type BuiltInAppIconId } from '../../../src/shared/app-icon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { APP_ICON_PREVIEWS } from './app-icon-previews'

// Same choices as the desktop's App icon setting; the names match the expo-alternate-app-icons entries in app.json.
const NATIVE_ICON_NAMES: Readonly<Record<BuiltInAppIconId, string | null>> = {
  classic: null,
  watercolor: 'Watercolor',
  blue: 'Blue'
}

function appIconIdOfNativeName(name: string | null): BuiltInAppIconId {
  return APP_ICON_OPTIONS.find((option) => NATIVE_ICON_NAMES[option.id] === name)?.id ?? 'classic'
}

export default function AppIconSettingsScreen({
  onBack
}: {
  onBack?: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [selected, setSelected] = useState<BuiltInAppIconId>(() =>
    supportsAlternateIcons ? appIconIdOfNativeName(getAppIconName()) : 'classic'
  )
  const [error, setError] = useState<string | null>(null)
  // One change at a time, so a failure always falls back to an icon the system confirmed.
  const [changing, setChanging] = useState(false)

  const select = (id: BuiltInAppIconId): void => {
    if (id === selected || changing) {
      return
    }
    setError(null)
    setChanging(true)
    const previous = selected
    setSelected(id)
    setAlternateAppIcon(NATIVE_ICON_NAMES[id])
      .catch(() => {
        setSelected(previous)
        setError(
          t('settings.appIconScreen.changeFailed', 'Could not change the app icon. Try again.')
        )
      })
      .finally(() => setChanging(false))
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('settings.appIconScreen.back', 'Back')}
          style={styles.backButton}
          onPress={onBack ?? (() => router.back())}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>{t('settings.appIconScreen.title', 'App icon')}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.groupDescription}>
          {supportsAlternateIcons
            ? t(
                'settings.appIconScreen.description',
                'Choose the icon Orca shows on your home screen.'
              )
            : t('settings.appIconScreen.unsupported', 'This device cannot change the app icon.')}
        </Text>
        {error && (
          <Text accessibilityRole="alert" style={styles.groupDescription}>
            {error}
          </Text>
        )}
        {supportsAlternateIcons && (
          <View style={[styles.section, styles.sectionTopGap]}>
            {APP_ICON_OPTIONS.map((option) => (
              <Pressable
                key={option.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: option.id === selected, disabled: changing }}
                disabled={changing}
                accessibilityLabel={option.label}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => select(option.id)}
              >
                <Image source={APP_ICON_PREVIEWS[option.id]} style={styles.preview} />
                <Text style={styles.rowLabel}>{option.label}</Text>
                {option.id === selected && <Check size={18} color={colors.accentBlue} />}
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
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
  groupDescription: {
    fontSize: typography.bodySize - 1,
    color: colors.textSecondary,
    lineHeight: 20,
    paddingHorizontal: spacing.xs
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.surface,
    overflow: 'hidden'
  },
  sectionTopGap: {
    marginTop: spacing.sm
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
    borderRadius: 10
  },
  rowLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  }
}))
