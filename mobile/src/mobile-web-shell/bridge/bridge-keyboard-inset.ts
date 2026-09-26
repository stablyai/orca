import { z } from 'zod'
import { BRIDGE_MAX_SAFE_AREA_INSET } from './bridge-safe-area-insets'

/**
 * The software keyboard's height as native screens read it on the shell's OS (iOS from the
 * window's bottom, Android above the bars), in the page's px; 0 while it is closed. The shell
 * overlays the IME on the view like a native screen, and the page cannot measure it.
 */
export const BridgeKeyboardInsetSchema = z.number().finite().min(0).max(BRIDGE_MAX_SAFE_AREA_INSET)

/**
 * What a page puts in `ready.accepts` to say it reads the keyboard from `init`. The shell overlays
 * the keyboard only on such a page; an older one cannot see it, so the shell shortens its view.
 */
export const BRIDGE_KEYBOARD_INSET_ACCEPT = 'keyboard-inset'
