import AsyncStorage from '@react-native-async-storage/async-storage'

export type LiveActivityPreferences = { enabled: boolean; showNames: boolean }
const KEY = 'orca:liveActivities'

export async function loadLiveActivityPreferences(): Promise<LiveActivityPreferences> {
  const raw = await AsyncStorage.getItem(KEY)
  const value = raw ? JSON.parse(raw) : null
  return { enabled: value?.enabled === true, showNames: value?.showNames === true }
}

export async function saveLiveActivityPreferences(value: LiveActivityPreferences): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(value))
}
