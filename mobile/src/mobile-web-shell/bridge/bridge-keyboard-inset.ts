import { z } from 'zod'
import { BRIDGE_MAX_SAFE_AREA_INSET } from './bridge-safe-area-insets'

/**
 * The software keyboard's height as native screens read it on the shell's OS (iOS from the
 * window's bottom, Android above the bars), in the page's px; 0 while it is closed. The shell
 * overlays the IME on the view like a native screen, and the page cannot measure it.
 */
export const BridgeKeyboardInsetSchema = z.number().finite().min(0).max(BRIDGE_MAX_SAFE_AREA_INSET)
