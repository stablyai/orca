import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Platform } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { ComposerUsageDisplayPicker } from '../composer-usage/ComposerUsageDisplayPicker'
import { ComposerUsageWindowPicker } from '../composer-usage/ComposerUsageWindowPicker'
import { useSideRailStrip } from '../layout/side-rail'
import {
  setRailRingsDuringChats,
  useRailRingsDuringChats
} from '../rail-usage/rail-rings-during-chats-preference'
import { ListRow } from '../components/list/ListGroup'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { PickerModal, type PickerOption } from '../components/sheets/PickerModal'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  nativeChatFontScale,
  resetNativeChatTextSettings,
  updateNativeChatTextSettings,
  useNativeChatTextSettingsSnapshot,
  type NativeChatFont
} from '../session/native-chat/preferences/native-chat-text-settings'
import { useMobileDefaultSessionViewPreference } from '../session/use-mobile-default-session-view-preference'
import {
  nativeChatLineSpacingSegments,
  NativeChatTextSizeSlider,
  nativeChatTextSizeLabel,
  StackedRow
} from './native-chat-text-controls'
import { NativeChatTextPreview } from './native-chat-text-preview'
import { SettingsScreen, SettingsSection, settingsScreenStylesSheet } from './settings-screen-frame'
import { useThemedStyles } from '../theme/themed-styles'

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

export default function NativeChatSettingsScreen({ onBack }: { onBack?: () => void }) {
  const settingsScreenStyles = useThemedStyles(settingsScreenStylesSheet)
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
  const label = t('settings.nativeChatSettingsScreen.openInChat', 'Open agent sessions in chat')
  // Only a window with a side rail (the iPhone Duo's status column) has rings to show.
  const hasSideRail = useSideRailStrip() !== null
  const ringsDuringChats = useRailRingsDuringChats()
  const ringsLabel = t(
    'settings.nativeChatSettingsScreen.railRingsDuringChats',
    'Show usage rings in the side rail during chats'
  )

  // The slider's gesture needs a root here, as Terminal settings has.
  return (
    <GestureHandlerRootView style={settingsScreenStyles.container}>
      <SettingsScreen
        title={t('settings.menuItems.chat', 'Chat')}
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
          title={t('settings.nativeChatText.heading', 'Text')}
          footer={t(
            'settings.nativeChatText.footer',
            'Pinch in a chat to change it; it saves here.'
          )}
        >
          <StackedRow
            key="size"
            title={t('settings.nativeChatText.size', 'Text size')}
            value={nativeChatTextSizeLabel(size, t)}
          >
            <NativeChatTextSizeSlider
              size={size}
              onValueChange={setDraggedSize}
              onSlidingComplete={(next) => {
                setDraggedSize(null)
                if (next !== settings.size) {
                  void updateNativeChatTextSettings({ size: next })
                }
              }}
            />
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
              segments={nativeChatLineSpacingSegments(t)}
              selected={settings.lineSpacing}
              onSelect={(lineSpacing) => void updateNativeChatTextSettings({ lineSpacing })}
              fill
              testIDPrefix="chat-text-spacing-"
            />
          </StackedRow>
        </SettingsSection>

        <SettingsSection
          footer={t(
            'settings.nativeChatSettingsScreen.defaultViewFooter',
            'Switch one session from its long-press menu.'
          )}
        >
          <ListRow
            key="chatDefault"
            title={label}
            accessory={
              <MobileSwitch
                accessibilityLabel={label}
                value={chatDefault}
                onValueChange={(next) => setDefaultView(next ? 'chat' : 'terminal')}
              />
            }
          />
        </SettingsSection>

        {stored ? (
          <SettingsSection>
            <ListRow
              key="reset"
              title={t('settings.nativeChatText.reset', 'Reset text settings')}
              onPress={() => void resetNativeChatTextSettings()}
              testID="chat-text-reset"
            />
          </SettingsSection>
        ) : null}

        <SettingsSection
          title={t('settings.nativeChatSettingsScreen.composerUsageHeading', 'COMPOSER USAGE')}
          footer={t(
            'settings.nativeChatSettingsScreen.composerUsageDescription',
            'Chat and agent terminal composers show your agent plan as used or left. Tap the meter for every window, reset times and pace.'
          )}
        >
          <ComposerUsageWindowPicker inSettings />
          <ComposerUsageDisplayPicker inSettings />
          {hasSideRail ? (
            <ListRow
              key="railRings"
              title={ringsLabel}
              subtitle={t(
                'settings.nativeChatSettingsScreen.railRingsDuringChatsHint',
                'When a chat leaves the status column free. A chat that fills the column always hides them.'
              )}
              accessory={
                <MobileSwitch
                  accessibilityLabel={ringsLabel}
                  value={ringsDuringChats}
                  onValueChange={setRailRingsDuringChats}
                  testID="rail-rings-during-chats"
                />
              }
            />
          ) : null}
        </SettingsSection>
      </SettingsScreen>
    </GestureHandlerRootView>
  )
}
