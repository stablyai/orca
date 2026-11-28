import { requireOptionalNativeModule } from 'expo-modules-core'
import type { NativeLiveActivities } from './native-live-activities'

const module = requireOptionalNativeModule<NativeLiveActivities>('OrcaLiveActivities')

// Older native clients cannot decode the aggregated content state.
export const nativeLiveActivities =
  module && typeof module.storeRoute === 'function' ? module : null
