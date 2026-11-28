/** Why a clipped capture is not the whole panel; null when it is whole or unmeasured. */
export function pluginShotClippedNote(shot: {
  clipped?: boolean
  contentHeight?: number
  height: number
}): string | null {
  return shot.clipped && shot.contentHeight !== undefined
    ? `the panel's content is ${shot.contentHeight}px tall; this capture shows only ${shot.height}px of it (what fits on screen)`
    : null
}
