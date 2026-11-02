import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Minus, Plus } from 'lucide-react-native'
import { ListRow } from '../components/list/ListGroup'
import { MobileSwitch } from '../components/MobileSwitch'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  getRecentSessionCardsMaxDisplaySync,
  hydrateRecentSessionCards,
  MAX_RECENT_SESSION_CARDS_LIMIT,
  MIN_RECENT_SESSION_CARDS_DISPLAY,
  setRecentSessionCardsMaxDisplay,
  subscribeRecentSessionCards
} from '../session/recent-session-cards'
import { useMobileDefaultSessionViewPreference } from '../session/use-mobile-default-session-view-preference'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SettingsScreen, SettingsSection } from './settings-screen-frame'

export default function NativeChatSettingsScreen({ onBack }: { onBack?: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()

  const { defaultView, setDefaultView } = useMobileDefaultSessionViewPreference()
  const chatDefault = defaultView === 'chat'
  const [recentMaxDisplay, setRecentMaxDisplay] = useState(() =>
    getRecentSessionCardsMaxDisplaySync()
  )
  useEffect(() => {
    void hydrateRecentSessionCards().catch(() => {})
    return subscribeRecentSessionCards(() =>
      setRecentMaxDisplay(getRecentSessionCardsMaxDisplaySync())
    )
  }, [])
  const canDecreaseRecent = recentMaxDisplay > MIN_RECENT_SESSION_CARDS_DISPLAY
  const canIncreaseRecent = recentMaxDisplay < MAX_RECENT_SESSION_CARDS_LIMIT
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
        title="RECENTLY USED"
        footer="Customize how many recently visited cards appear in the session menu (default 7)."
      >
        <ListRow
          key="maxRecentItems"
          title="Max recent items"
          subtitle={`${recentMaxDisplay} cards`}
          accessory={
            <View style={styles.stepper}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Decrease max recent items"
                disabled={!canDecreaseRecent}
                onPress={() => setRecentSessionCardsMaxDisplay(recentMaxDisplay - 1)}
                style={({ pressed }) => [
                  styles.stepperButton,
                  !canDecreaseRecent && styles.stepperButtonDisabled,
                  pressed && canDecreaseRecent && styles.stepperButtonPressed
                ]}
              >
                <Minus size={16} color={colors.textPrimary} />
              </Pressable>
              <Text style={styles.stepperValue}>{recentMaxDisplay}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Increase max recent items"
                disabled={!canIncreaseRecent}
                onPress={() => setRecentSessionCardsMaxDisplay(recentMaxDisplay + 1)}
                style={({ pressed }) => [
                  styles.stepperButton,
                  !canIncreaseRecent && styles.stepperButtonDisabled,
                  pressed && canIncreaseRecent && styles.stepperButtonPressed
                ]}
              >
                <Plus size={16} color={colors.textPrimary} />
              </Pressable>
            </View>
          }
        />
      </SettingsSection>
    </SettingsScreen>
  )
}

const styles = themedStyleSheet(() => ({
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.bgRaised,
    borderRadius: 8,
    padding: 4
  },
  stepperButton: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  stepperButtonPressed: {
    backgroundColor: colors.bgPanel
  },
  stepperButtonDisabled: {
    opacity: 0.35
  },
  stepperValue: {
    minWidth: 24,
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary,
    textAlign: 'center'
  }
}))
