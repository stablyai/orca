import { ScrollView, Text, View } from 'react-native'
import { MessageSquare } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileOnboardingStep } from './mobile-onboarding-plan'
import { mobileOnboardingStylesSheet } from './mobile-onboarding-styles'
import { NotificationOnboardingPreview } from './NotificationOnboardingPreview'
import { SheetPrimaryButton } from '../components/sheets/SheetPrimaryButton'
import { SheetSecondaryButton } from '../components/sheets/SheetSecondaryButton'
import type { MobileSessionView } from '../storage/session-view-preferences'
import { useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'

export type NotificationOnboardingChoice = 'enable' | 'skip'
export type MobileOnboardingBusyChoice = MobileSessionView | NotificationOnboardingChoice | null

type Props = {
  step: MobileOnboardingStep
  width: number
  active: boolean
  busyChoice: MobileOnboardingBusyChoice
  error: string | null
  onSessionChoice: (view: MobileSessionView) => void
  onNotificationChoice: (choice: NotificationOnboardingChoice) => void
}

export function MobileOnboardingPage({
  step,
  width,
  active,
  busyChoice,
  error,
  onSessionChoice,
  onNotificationChoice
}: Props) {
  const colors = useMobileColors()
  const styles = useThemedStyles(mobileOnboardingStylesSheet)
  const t = useMobileTranslation()
  const busy = busyChoice !== null
  const isSessionView = step === 'session-view'

  return (
    <ScrollView
      style={[styles.page, { width }]}
      contentContainerStyle={styles.pageContent}
      showsVerticalScrollIndicator={false}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      <View style={[styles.content, !isSessionView && styles.notificationContent]}>
        {isSessionView ? (
          <View style={styles.iconSurface}>
            <MessageSquare size={30} color={colors.textPrimary} />
          </View>
        ) : (
          <NotificationOnboardingPreview active={active} />
        )}
        <Text style={styles.title}>
          {isSessionView
            ? t('onboarding.onboardingPage.sessionViewTitle', 'How should sessions open?')
            : t(
                'onboarding.onboardingPage.notificationsTitle',
                'Don’t miss when an agent needs you'
              )}
        </Text>
        <Text style={styles.body}>
          {isSessionView
            ? t(
                'onboarding.onboardingPage.sessionViewLine',
                'You can change this any time in Settings → Chat UI.'
              )
            : t(
                'onboarding.onboardingPage.notificationsLine',
                'Orca’s push service tells this phone when an agent finishes or needs you while your computer is idle.'
              )}
        </Text>
      </View>

      <View style={styles.footer}>
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        {isSessionView ? (
          <SessionViewChoices busyChoice={busyChoice} disabled={busy} onChoice={onSessionChoice} />
        ) : (
          <NotificationChoices
            busyChoice={busyChoice}
            disabled={busy}
            onChoice={onNotificationChoice}
          />
        )}
      </View>
    </ScrollView>
  )
}

function SessionViewChoices({
  busyChoice,
  disabled,
  onChoice
}: {
  busyChoice: MobileOnboardingBusyChoice
  disabled: boolean
  onChoice: (view: MobileSessionView) => void
}) {
  const t = useMobileTranslation()
  return (
    <>
      <SheetPrimaryButton
        label={t('onboarding.onboardingPage.useChatUi', 'Use Chat UI')}
        busy={busyChoice === 'chat'}
        disabled={disabled}
        onPress={() => onChoice('chat')}
      />
      <SheetSecondaryButton
        label={t('onboarding.onboardingPage.keepTerminal', 'Keep terminal')}
        accessibilityLabel={t(
          'onboarding.onboardingPage.openInTerminal',
          'Open sessions in the terminal'
        )}
        busy={busyChoice === 'terminal'}
        disabled={disabled}
        onPress={() => onChoice('terminal')}
      />
    </>
  )
}

function NotificationChoices({
  busyChoice,
  disabled,
  onChoice
}: {
  busyChoice: MobileOnboardingBusyChoice
  disabled: boolean
  onChoice: (choice: NotificationOnboardingChoice) => void
}) {
  const t = useMobileTranslation()
  return (
    <>
      <SheetPrimaryButton
        label={t('onboarding.onboardingPage.enableNotifications', 'Enable notifications')}
        busy={busyChoice === 'enable'}
        disabled={disabled}
        onPress={() => onChoice('enable')}
      />
      <SheetSecondaryButton
        label={t('onboarding.onboardingPage.notNow', 'Not now')}
        accessibilityLabel={t(
          'onboarding.onboardingPage.skipNotifications',
          'Skip notifications for now'
        )}
        busy={busyChoice === 'skip'}
        disabled={disabled}
        onPress={() => onChoice('skip')}
      />
    </>
  )
}
