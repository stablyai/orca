import { ScrollView, Text, View } from 'react-native'
import type { MobileOnboardingStep } from './mobile-onboarding-plan'
import { mobileOnboardingStyles as styles } from './mobile-onboarding-styles'
import { NotificationOnboardingPreview } from './NotificationOnboardingPreview'
import type { MobileSessionView } from '../storage/session-view-preferences'
import { Button } from '../components/ui/Button'

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
        {isSessionView ? null : <NotificationOnboardingPreview active={active} />}
        <Text style={styles.title}>
          {isSessionView ? 'How should sessions open?' : 'Don’t miss when an agent needs you'}
        </Text>
        <Text style={styles.body}>
          {isSessionView
            ? 'Choose whether supported agent sessions open in the terminal or Chat UI on this device. Press and hold a session tab to switch its view, or change the default later in Settings.'
            : 'Get a notification on this phone when an agent finishes or is waiting — even if you aren’t using the app.'}
        </Text>
      </View>

      <View style={styles.footer}>
        {!isSessionView ? (
          <Text style={styles.disclosure}>
            Delivered through Orca’s push service after your desktop has been idle for 3 minutes.
            Change this anytime in Settings.
          </Text>
        ) : null}
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        <View style={styles.choices}>
          {isSessionView ? (
            <SessionViewChoices
              busyChoice={busyChoice}
              disabled={busy}
              onChoice={onSessionChoice}
            />
          ) : (
            <NotificationChoices
              busyChoice={busyChoice}
              disabled={busy}
              onChoice={onNotificationChoice}
            />
          )}
        </View>
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
  return (
    <>
      <ChoiceButton
        label="Use Chat UI"
        accessibilityLabel="Open sessions in Chat UI"
        primary
        busy={busyChoice === 'chat'}
        disabled={disabled}
        onPress={() => onChoice('chat')}
      />
      <ChoiceButton
        label="Keep terminal"
        accessibilityLabel="Open sessions in the terminal"
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
  return (
    <>
      <ChoiceButton
        label="Enable notifications"
        accessibilityLabel="Enable agent notifications"
        primary
        busy={busyChoice === 'enable'}
        disabled={disabled}
        onPress={() => onChoice('enable')}
      />
      <ChoiceButton
        label="Not now"
        accessibilityLabel="Skip notifications for now"
        busy={busyChoice === 'skip'}
        disabled={disabled}
        onPress={() => onChoice('skip')}
      />
    </>
  )
}

function ChoiceButton({
  label,
  accessibilityLabel,
  primary = false,
  busy,
  disabled,
  onPress
}: {
  label: string
  accessibilityLabel?: string
  primary?: boolean
  busy: boolean
  disabled: boolean
  onPress: () => void
}) {
  return (
    <Button
      label={label}
      accessibilityLabel={accessibilityLabel}
      variant={primary ? 'primary' : 'plain'}
      busy={busy}
      // The busy button keeps full strength; only the one that is waiting its turn dims.
      disabled={disabled && !busy}
      block
      onPress={onPress}
    />
  )
}
