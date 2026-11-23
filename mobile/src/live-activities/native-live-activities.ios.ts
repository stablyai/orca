import { requireOptionalNativeModule } from 'expo-modules-core'
import type { NativeLiveActivities } from './native-live-activities'

export const nativeLiveActivities =
  requireOptionalNativeModule<NativeLiveActivities>('OrcaLiveActivities')
