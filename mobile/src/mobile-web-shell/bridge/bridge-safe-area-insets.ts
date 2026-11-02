import { z } from 'zod'

export const BRIDGE_MAX_SAFE_AREA_INSET = 4096

const insetSchema = z.number().finite().min(0).max(BRIDGE_MAX_SAFE_AREA_INSET)

// WebView env(safe-area-inset-*) reports zero, so native publishes bar/cutout coverage in page px through init. Absent means the older shell reserved those strips outside the view.
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
