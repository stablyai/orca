/** Undo the presented quarter-turn before mapping normalized input to natural-display pixels. */
export function emulatorDisplayCoordinates(
  x: number,
  y: number,
  rotation: number,
  display: { width: number; height: number }
): { x: number; y: number } {
  const [nx, ny] = [
    [x, y],
    [1 - y, x],
    [1 - x, 1 - y],
    [y, 1 - x]
  ][rotation] ?? [x, y]
  return {
    x: Math.max(0, Math.min(display.width - 1, Math.round(nx * display.width))),
    y: Math.max(0, Math.min(display.height - 1, Math.round(ny * display.height)))
  }
}
