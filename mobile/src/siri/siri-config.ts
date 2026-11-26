import Constants from 'expo-constants'
import { Platform } from 'react-native'

export function isSiriEnabled(): boolean {
  return Platform.OS === 'ios' && Constants.expoConfig?.extra?.orcaSiri === true
}
