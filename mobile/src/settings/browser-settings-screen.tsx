import { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, ChevronRight, Globe, Network } from 'lucide-react-native'
import { PickerModal, type PickerOption } from '../components/PickerModal'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  DEFAULT_BROWSER_DRAWING,
  DEFAULT_TERMINAL_LINK_OPEN_MODE,
  loadBrowserDrawing,
  loadTerminalLinkOpenMode,
  saveBrowserDrawing,
  saveTerminalLinkOpenMode,
  type MobileBrowserDrawing,
  type MobileTerminalLinkOpenMode
} from '../storage/preferences'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useSavedBrowserPreference } from './use-saved-browser-preference'

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

function drawingOptions(t: Translate): PickerOption<MobileBrowserDrawing>[] {
  return [
    {
      value: 'stream',
      label: t('settings.browserSettingsScreen.streamDrawing', 'Stream from the host'),
      subtitle: t(
        'settings.browserSettingsScreen.streamDrawingDescription',
        "Show pictures of the desktop's browser; the phone button still draws a tab here."
      )
    },
    {
      value: 'host',
      label: t('settings.browserSettingsScreen.hostDrawing', 'Draw on the phone, through the host'),
      subtitle: t(
        'settings.browserSettingsScreen.hostNetworkDescription',
        'Traffic goes out from your paired desktop, using its network and proxy settings.'
      )
    },
    {
      value: 'phone',
      label: t('settings.browserSettingsScreen.phoneDrawing', 'Draw on the phone, on its network'),
      subtitle: t(
        'settings.browserSettingsScreen.phoneNetworkDescription',
        'Traffic goes out from this phone, like any app on it.'
      )
    }
  ]
}

function optionLabel<T extends string>(value: T, options: PickerOption<T>[]): string {
  return options.find((option) => option.value === value)?.label ?? options[0]!.label
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
  const [pickerOpen, setPickerOpen] = useState<'links' | 'drawing' | null>(null)
  const linkMode = useSavedBrowserPreference(
    loadTerminalLinkOpenMode,
    saveTerminalLinkOpenMode,
    DEFAULT_TERMINAL_LINK_OPEN_MODE
  )
  const drawing = useSavedBrowserPreference(
    loadBrowserDrawing,
    saveBrowserDrawing,
    DEFAULT_BROWSER_DRAWING
  )
  const options = linkModeOptions(t)
  const drawings = drawingOptions(t)
  const error = linkMode.error ?? drawing.error

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
            onPress={() => setPickerOpen('links')}
          >
            <Globe size={16} color={colors.textSecondary} />
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>
                {t('settings.browserSettingsScreen.openTerminalLinks', 'Open terminal links')}
              </Text>
              <Text style={styles.rowSublabel}>{optionLabel(linkMode.value, options)}</Text>
            </View>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
        </View>

        <Text style={[styles.groupHeading, styles.groupTopGap]}>
          {t('settings.browserSettingsScreen.tabsHeading', 'BROWSER TABS')}
        </Text>
        <Text style={styles.groupDescription}>
          {t(
            'settings.browserSettingsScreen.tabsDescription',
            'Choose how browser tabs show on the phone, and the network pages drawn here use.'
          )}
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('settings.browserSettingsScreen.showTabs', 'Show tabs')}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setPickerOpen('drawing')}
          >
            <Network size={16} color={colors.textSecondary} />
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>
                {t('settings.browserSettingsScreen.showTabs', 'Show tabs')}
              </Text>
              <Text style={styles.rowSublabel}>{optionLabel(drawing.value, drawings)}</Text>
            </View>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
        </View>
      </ScrollView>

      <PickerModal<MobileTerminalLinkOpenMode>
        visible={pickerOpen === 'links'}
        title={t('settings.browserSettingsScreen.openTerminalLinks', 'Open terminal links')}
        options={options}
        selected={linkMode.value}
        onSelect={linkMode.select}
        onClose={() => setPickerOpen(null)}
      />
      <PickerModal<MobileBrowserDrawing>
        visible={pickerOpen === 'drawing'}
        title={t('settings.browserSettingsScreen.showTabs', 'Show tabs')}
        options={drawings}
        selected={drawing.value}
        onSelect={drawing.select}
        onClose={() => setPickerOpen(null)}
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
  groupTopGap: {
    marginTop: spacing.xl
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
