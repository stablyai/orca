import { readPushNotificationsPreference } from '../storage/preferences'

export async function shouldPresentNotificationOptIn(): Promise<boolean> {
  const preference = await readPushNotificationsPreference()
  return preference.loaded && preference.value === null
}
