import { Platform } from 'react-native'
import type { NativeStackNavigationOptions } from 'expo-router'
import { colors } from '../../theme/mobile-theme'

/** Stack header styling: iOS keeps the system bar (Liquid Glass on 26); Android a Material 3 top app bar. */
export function nativeHeaderOptions(): NativeStackNavigationOptions {
  if (Platform.OS === 'ios') {
    return { headerBackButtonDisplayMode: 'minimal' }
  }
  return {
    headerStyle: { backgroundColor: colors.bgBase },
    headerTintColor: colors.textPrimary,
    headerShadowVisible: false
  }
}
