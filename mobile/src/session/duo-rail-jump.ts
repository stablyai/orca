import type { ReservedRect } from '../../modules/orca-reserved-regions/src'
import { duoRailJumpFrames, type DuoRailJumpFrames } from '../layout/duo-status-row'
import type { SideRailStrip } from '../layout/side-rail-strip'

/** Rail frames when chat is collapsed beside a column with room above the composer. */
export function duoRailJumpPlacement(args: {
  chatVisible: boolean
  expanded: boolean
  strip: SideRailStrip | null
  keyboardInset: number
  composerTop: number | null
  windowWidth: number
  windowHeight: number
  occlusions: readonly ReservedRect[]
}): DuoRailJumpFrames | null {
  if (!args.chatVisible || args.expanded || args.strip === null || args.composerTop === null) {
    return null
  }
  return duoRailJumpFrames({
    windowWidth: args.windowWidth,
    windowHeight: args.windowHeight,
    strip: args.strip,
    occlusions: args.occlusions,
    composerTop: args.composerTop,
    keyboardUp: args.keyboardInset > 0
  })
}
