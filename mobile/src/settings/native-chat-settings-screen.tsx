import { useRouter } from 'expo-router'
import { useState, type ReactNode } from 'react'
import { Platform, Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { ListRow } from '../components/list/ListGroup'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { MobileSlider } from '../components/controls/MobileSlider'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { PickerModal, type PickerOption } from '../components/sheets/PickerModal'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  defaultNativeChatTextSettings,
  NATIVE_CHAT_TEXT_SIZE_MAX,
  NATIVE_CHAT_TEXT_SIZE_MIN,
  nativeChatFontScale,
  resetNativeChatTextSettings,
  updateNativeChatTextSettings,
  useNativeChatTextSettingsSnapshot,
  type NativeChatFont,
  type NativeChatLineSpacing
} from '../session/native-chat/preferences/native-chat-text-settings'
import { useMobileDefaultSessionViewPreference } from '../session/use-mobile-default-session-view-preference'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { NativeChatTextPreview } from './native-chat-text-preview'
import { SettingsScreen, SettingsSection, settingsScreenStyles } from './settings-screen-frame'

const IOS = Platform.OS === 'ios'

function fontOptions(t: Translate): PickerOption<NativeChatFont>[] {
  return [
    {
      value: 'system',
      label: t('settings.nativeChatText.fontSystem', 'System'),
      subtitle: IOS ? 'SF Pro' : 'Roboto'
    },
    {
      value: 'serif',
      label: t('settings.nativeChatText.fontSerif', 'Serif'),
      subtitle: IOS ? 'New York' : 'Noto Serif'
    },
    {
      value: 'mono',
      label: t('settings.nativeChatText.fontMono', 'Monospace'),
      subtitle: t('settings.nativeChatText.fontMonoSubtitle', 'Same as code')
    }
  ]
}

function lineSpacingSegments(t: Translate): { value: NativeChatLineSpacing; label: string }[] {
  return [
    { value: 'compact', label: t('settings.nativeChatText.spacingCompact', 'Compact') },
    { value: 'default', label: t('settings.nativeChatText.spacingDefault', 'Default') },
    { value: 'relaxed', label: t('settings.nativeChatText.spacingRelaxed', 'Relaxed') }
  ]
}

/** A row whose control sits under its title, for controls too wide to share the line. */
function StackedRow({
  title,
  value,
  children
}: {
  title: string
  value?: string
  children: ReactNode
}) {
  useMobileColorScheme()
  return (
    <View style={styles.stacked}>
      <View style={styles.stackedHeader}>
        <Text style={styles.stackedTitle}>{title}</Text>
        {value !== undefined ? <Text style={styles.stackedValue}>{value}</Text> : null}
      </View>
      {children}
    </View>
  )
}

export default function NativeChatSettingsScreen({ onBack }: { onBack?: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const { settings, stored } = useNativeChatTextSettingsSnapshot()
  const [fontPickerOpen, setFontPickerOpen] = useState(false)
  // The preview follows a drag; the size saves once when it ends.
  const [draggedSize, setDraggedSize] = useState<number | null>(null)
  const size = draggedSize ?? settings.size
  const fonts = fontOptions(t)

  const { defaultView, setDefaultView } = useMobileDefaultSessionViewPreference()
  const chatDefault = defaultView === 'chat'
  const label = t('settings.nativeChatSettingsScreen.openInChatUi', 'Open sessions in Chat UI')

  // The slider's gesture needs a root here, as Terminal settings has.
  return (
    <GestureHandlerRootView style={settingsScreenStyles.container}>
      <SettingsScreen
        title={t('settings.nativeChatSettingsScreen.title', 'Chat UI')}
        onBack={onBack ?? (() => router.back())}
        overlays={
          <PickerModal<NativeChatFont>
            visible={fontPickerOpen}
            title={t('settings.nativeChatText.fontPickerTitle', 'Chat font')}
            options={fonts}
            selected={settings.font}
            onSelect={(font) => void updateNativeChatTextSettings({ font })}
            onClose={() => setFontPickerOpen(false)}
          />
        }
      >
        <NativeChatTextPreview fontScale={nativeChatFontScale(size)} />
        <SettingsSection
          first
          title={t('settings.nativeChatText.heading', 'TEXT')}
          footer={t(
            'settings.nativeChatText.footer',
            'Pinch in a chat to change it; it saves here.'
          )}
        >
          <StackedRow
            key="size"
            title={t('settings.nativeChatText.size', 'Text size')}
            value={
              size === defaultNativeChatTextSettings().size
                ? t('settings.nativeChatText.sizeDefault', 'Default')
                : t('settings.nativeChatText.sizePoints', '{{size}} pt', { size })
            }
          >
            <View style={styles.sliderLine}>
              <Text style={styles.smallA} importantForAccessibility="no">
                A
              </Text>
              <View style={styles.slider}>
                <MobileSlider
                  value={size}
                  min={NATIVE_CHAT_TEXT_SIZE_MIN}
                  max={NATIVE_CHAT_TEXT_SIZE_MAX}
                  onValueChange={setDraggedSize}
                  onSlidingComplete={(next) => {
                    setDraggedSize(null)
                    if (next !== settings.size) {
                      void updateNativeChatTextSettings({ size: next })
                    }
                  }}
                  accessibilityLabel={t('settings.nativeChatText.size', 'Text size')}
                  accessibilityValueText={t(
                    'settings.nativeChatText.sizeSpoken',
                    '{{size}} points',
                    {
                      size
                    }
                  )}
                  testID="chat-text-size"
                />
              </View>
              <Text style={styles.largeA} importantForAccessibility="no">
                A
              </Text>
            </View>
          </StackedRow>
          <ListRow
            key="font"
            title={t('settings.nativeChatText.font', 'Font')}
            value={fonts.find((option) => option.value === settings.font)?.label}
            navigates
            onPress={() => setFontPickerOpen(true)}
            testID="chat-text-font"
          />
          <StackedRow
            key="spacing"
            title={t('settings.nativeChatText.lineSpacing', 'Line spacing')}
          >
            <MobileSegmentedControl
              segments={lineSpacingSegments(t)}
              selected={settings.lineSpacing}
              onSelect={(lineSpacing) => void updateNativeChatTextSettings({ lineSpacing })}
              fill
              testIDPrefix="chat-text-spacing-"
            />
          </StackedRow>
        </SettingsSection>

        <SettingsSection
          title={t('settings.nativeChatSettingsScreen.defaultViewHeading', 'DEFAULT VIEW')}
          footer={t(
            'settings.nativeChatSettingsScreen.defaultViewDescription',
            'Choose how supported agent sessions (Claude, Codex, and other chat-capable agents) open on this device. Terminal shows the raw CLI; Chat UI shows a chat interface like the desktop app. You can still switch any individual session from its long-press menu.'
          )}
        >
          <ListRow
            key="chatDefault"
            title={label}
            subtitle={
              chatDefault
                ? t('settings.nativeChatSettingsScreen.on', 'On')
                : t('settings.nativeChatSettingsScreen.off', 'Off')
            }
            accessory={
              <MobileSwitch
                accessibilityLabel={label}
                value={chatDefault}
                onValueChange={(next) => setDefaultView(next ? 'chat' : 'terminal')}
              />
            }
          />
        </SettingsSection>

        <SettingsSection>
          <ListRow
            key="reset"
            title={t('settings.nativeChatText.reset', 'Reset text settings')}
            disabled={!stored}
            onPress={() => void resetNativeChatTextSettings()}
            testID="chat-text-reset"
          />
        </SettingsSection>
      </SettingsScreen>
    </GestureHandlerRootView>
  )
}

const styles = themedStyleSheet(() => ({
  stacked: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.xs
  },
  stackedHeader: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  stackedTitle: { fontSize: 15, color: colors.textPrimary },
  stackedValue: { fontSize: 15, color: colors.textSecondary },
  sliderLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  slider: { flex: 1 },
  smallA: { fontSize: 13, color: colors.textSecondary },
  largeA: { fontSize: 20, color: colors.textSecondary }
}))
