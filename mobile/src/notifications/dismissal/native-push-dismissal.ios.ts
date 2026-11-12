import { requireNativeModule } from 'expo-modules-core'
import type { NativeDismissal } from './native-push-dismissal'

export const nativePushDismissal = requireNativeModule<NativeDismissal>('OrcaNotificationDismissal')
