const POP_DISTANCE = 64

// The strip is only the left edge, so a horizontal move there is the back swipe the native stack no longer owns.
export function shellBackEdgeClaims(dx: number, dy: number): boolean {
  return dx > 12 && dx > Math.abs(dy)
}

export function shellBackEdgePops(dx: number, dy: number): boolean {
  return dx >= POP_DISTANCE && dx > Math.abs(dy)
}
