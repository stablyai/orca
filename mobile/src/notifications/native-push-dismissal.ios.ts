import { requireNativeModule } from 'expo'
import type { NativeDismissal } from './native-push-dismissal'

export const nativePushDismissal = requireNativeModule<NativeDismissal>('OrcaNotificationDismissal')
