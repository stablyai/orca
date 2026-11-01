import { z } from 'zod'
import { BRIDGE_MAX_SAFE_AREA_INSET } from './bridge-safe-area-insets'

const coordinate = z.number().finite().min(0).max(BRIDGE_MAX_SAFE_AREA_INSET)
export const BridgePageGeometrySchema = z.object({
  occlusions: z
    .array(z.object({ x: coordinate, y: coordinate, width: coordinate, height: coordinate }))
    .max(16),
  sideRail: z.boolean(),
  directionPadAvailable: z.boolean().optional()
})
export type BridgePageGeometry = z.infer<typeof BridgePageGeometrySchema>
export const EMPTY_PAGE_GEOMETRY: BridgePageGeometry = { occlusions: [], sideRail: false }
export function samePageGeometry(a: BridgePageGeometry, b: BridgePageGeometry): boolean {
  return (
    a.sideRail === b.sideRail &&
    a.directionPadAvailable === b.directionPadAvailable &&
    a.occlusions.length === b.occlusions.length &&
    a.occlusions.every((rect, i) => {
      const other = b.occlusions[i]
      return (
        other !== undefined &&
        rect.x === other.x &&
        rect.y === other.y &&
        rect.width === other.width &&
        rect.height === other.height
      )
    })
  )
}

/** Native regions are window points; the web header measures in the WebView's local points. */
export function pageOcclusions(
  regions: readonly { x: number; y: number; width: number; height: number }[],
  frame: { x: number; y: number; width: number; height: number } | null
): BridgePageGeometry['occlusions'] {
  if (frame === null) {
    return []
  }
  return regions.flatMap((rect) => {
    const x = Math.max(0, rect.x - frame.x)
    const y = Math.max(0, rect.y - frame.y)
    const right = Math.min(frame.width, rect.x + rect.width - frame.x)
    const bottom = Math.min(frame.height, rect.y + rect.height - frame.y)
    return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y }] : []
  })
}
