import { Redirect, useLocalSearchParams } from 'expo-router'
import {
  legacyNotificationOptInDestination,
  type LegacyNotificationOptInParams
} from '../src/onboarding/legacy-notification-opt-in-destination'

export default function NotificationOptInRedirect() {
  const params = useLocalSearchParams<LegacyNotificationOptInParams>()

  // Why: restored stacks may contain this retired route; replacement keeps Back from reopening it.
  return <Redirect href={legacyNotificationOptInDestination(params)} />
}
