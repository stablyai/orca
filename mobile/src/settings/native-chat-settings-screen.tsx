import { useRouter } from 'expo-router'
import { ListRow } from '../components/list/ListGroup'
import { MobileSwitch } from '../components/MobileSwitch'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileDefaultSessionViewPreference } from '../session/use-mobile-default-session-view-preference'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SettingsScreen, SettingsSection } from './settings-screen-frame'
import { ComposerUsageWindowPicker } from '../composer-usage/ComposerUsageWindowPicker'

export default function NativeChatSettingsScreen({ onBack }: { onBack?: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()

  const { defaultView, setDefaultView } = useMobileDefaultSessionViewPreference()
  const chatDefault = defaultView === 'chat'
  const label = t('settings.nativeChatSettingsScreen.openInChatUi', 'Open sessions in Chat UI')

  return (
    <SettingsScreen
      title={t('settings.nativeChatSettingsScreen.title', 'Chat UI')}
      onBack={onBack ?? (() => router.back())}
    >
      <SettingsSection
        first
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
      <SettingsSection
        title={t('settings.nativeChatSettingsScreen.composerUsageHeading', 'COMPOSER USAGE')}
        footer={t(
          'settings.nativeChatSettingsScreen.composerUsageDescription',
          'Chat and agent terminal composers show how much of your agent plan is used. Tap the meter for every window, reset times and pace.'
        )}
      >
        <ComposerUsageWindowPicker inSettings />
      </SettingsSection>
    </SettingsScreen>
  )
}
