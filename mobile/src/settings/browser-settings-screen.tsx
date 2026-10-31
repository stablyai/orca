import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, ChevronRight, Globe } from 'lucide-react-native'
import { PickerModal, type PickerOption } from '../components/PickerModal'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  loadTerminalLinkOpenMode,
  saveTerminalLinkOpenMode,
  type MobileTerminalLinkOpenMode
} from '../storage/preferences'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

function linkModeOptions(t: Translate): PickerOption<MobileTerminalLinkOpenMode>[] {
  return [
    {
      value: 'orca-browser',
      label: t('settings.browserSettingsScreen.desktopBrowser', 'Orca browser on desktop'),
      subtitle: t(
        'settings.browserSettingsScreen.desktopBrowserDescription',
        'Open in the streamed browser from your paired desktop.'
      )
    },
    {
      value: 'phone-browser',
      label: t('settings.browserSettingsScreen.phoneBrowser', 'Phone browser'),
      subtitle: t(
        'settings.browserSettingsScreen.phoneBrowserDescription',
        'Open in Safari, Chrome, or another browser on this phone.'
      )
    }
  ]
}

function linkModeLabel(
  mode: MobileTerminalLinkOpenMode,
  options: PickerOption<MobileTerminalLinkOpenMode>[]
): string {
  return options.find((option) => option.value === mode)?.label ?? options[0]!.label
}

export default function BrowserSettingsScreen({
  onBack
}: {
  onBack?: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [linkMode, setLinkMode] = useState<MobileTerminalLinkOpenMode>('orca-browser')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState<'load' | 'save' | null>(null)
  const options = linkModeOptions(t)
  const selectionRevision = useRef(0)
  const failedSelectionRevision = useRef<number | null>(null)
  const savedMode = useRef<MobileTerminalLinkOpenMode>('orca-browser')
  const hasSaved = useRef(false)

  useEffect(() => {
    let active = true
    void loadTerminalLinkOpenMode().then(
      (mode) => {
        if (!hasSaved.current) {
          savedMode.current = mode
        }
        if (
          active &&
          (selectionRevision.current === 0 ||
            failedSelectionRevision.current === selectionRevision.current)
        ) {
          setLinkMode(savedMode.current)
        }
      },
      () => {
        if (active) {
          setError('load')
        }
      }
    )
    return () => {
      active = false
    }
  }, [])

  const selectLinkMode = useCallback((mode: MobileTerminalLinkOpenMode) => {
    setError(null)
    const revision = ++selectionRevision.current
    setLinkMode(mode)
    void saveTerminalLinkOpenMode(mode).then(
      () => {
        savedMode.current = mode
        hasSaved.current = true
      },
      () => {
        if (revision === selectionRevision.current) {
          failedSelectionRevision.current = revision
          setLinkMode(savedMode.current)
          setError('save')
        }
      }
    )
  }, [])

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
          style={styles.backButton}
          onPress={onBack ?? (() => router.back())}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>{t('settings.browserSettingsScreen.title', 'Browser')}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.groupHeading}>
          {t('settings.browserSettingsScreen.linksHeading', 'LINKS')}
        </Text>
        <Text style={styles.groupDescription}>
          {t(
            'settings.browserSettingsScreen.linksDescription',
            'Choose where HTTP(S) links tapped in terminal output open.'
          )}
        </Text>
        {error && (
          <Text accessibilityRole="alert" style={styles.groupDescription}>
            {error === 'load'
              ? t(
                  'settings.browserSettingsScreen.loadFailed',
                  'Could not load browser preferences. Try again.'
                )
              : t(
                  'settings.browserSettingsScreen.saveFailed',
                  'Could not save browser preferences. Try again.'
                )}
          </Text>
        )}
        <View style={[styles.section, styles.sectionTopGap]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(
              'settings.browserSettingsScreen.openTerminalLinks',
              'Open terminal links'
            )}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setPickerOpen(true)}
          >
            <Globe size={16} color={colors.textSecondary} />
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>
                {t('settings.browserSettingsScreen.openTerminalLinks', 'Open terminal links')}
              </Text>
              <Text style={styles.rowSublabel}>{linkModeLabel(linkMode, options)}</Text>
            </View>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
        </View>
      </ScrollView>

      <PickerModal<MobileTerminalLinkOpenMode>
        visible={pickerOpen}
        title={t('settings.browserSettingsScreen.openTerminalLinks', 'Open terminal links')}
        options={options}
        selected={linkMode}
        onSelect={selectLinkMode}
        onClose={() => setPickerOpen(false)}
      />
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
    borderRadius: radii.control,
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
    borderRadius: radii.surface,
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
}))
