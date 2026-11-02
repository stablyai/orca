import { z } from 'zod'
import { BRIDGE_MAX_SAFE_AREA_INSET } from './bridge-safe-area-insets'

// Publish native keyboard height in page px (iOS from window bottom, Android above bars); the shell overlays IME so the page cannot measure it itself.
export const BridgeKeyboardInsetSchema = z.number().finite().min(0).max(BRIDGE_MAX_SAFE_AREA_INSET)
