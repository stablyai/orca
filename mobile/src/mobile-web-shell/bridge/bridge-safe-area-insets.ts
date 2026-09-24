import { z } from 'zod'

/** Far past any system bar or cutout; a larger value is a broken producer, not a device. */
export const BRIDGE_MAX_SAFE_AREA_INSET = 4096

const insetSchema = z.number().finite().min(0).max(BRIDGE_MAX_SAFE_AREA_INSET)

/**
 * How much of the page's WebView sits under a system bar, per edge, in the page's own px.
 *
 * The shell lays the WebView out edge-to-edge like a native screen, so the page pads for the bars
 * the way native screens do: through react-native-safe-area-context. The web provider cannot
 * measure them (`env(safe-area-inset-*)` reads 0 in both WebViews), so the shell says them in
 * `init`. Optional and additive: absent reads as zeros, which is the old shell that reserved the
 * strips outside the view itself.
 */
export const BridgeSafeAreaInsetsSchema = z.object({
  top: insetSchema,
  right: insetSchema,
  bottom: insetSchema,
  left: insetSchema
})

export type BridgeSafeAreaInsets = z.infer<typeof BridgeSafeAreaInsetsSchema>

export const ZERO_SAFE_AREA_INSETS: BridgeSafeAreaInsets = Object.freeze({
  top: 0,
  right: 0,
  bottom: 0,
  left: 0
})

export function sameSafeAreaInsets(
  left: BridgeSafeAreaInsets,
  right: BridgeSafeAreaInsets
): boolean {
  return (
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom &&
    left.left === right.left
  )
}

/**
 * What a page puts in `ready.accepts` to say it pads for the system bars itself. The shell draws
 * the WebView edge-to-edge only for such a page: an older page has no reader for the insets and
 * would lay its header under the status bar, so it keeps the strips the shell reserves.
 */
export const BRIDGE_SAFE_AREA_ACCEPT = 'safe-area-insets'
