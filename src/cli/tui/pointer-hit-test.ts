/** A screen rectangle in terminal cells (0-based, half-open on width/height). */
export type Rect = { x: number; y: number; width: number; height: number }

export type HitTarget<T> = { rect: Rect; value: T }

function contains(rect: Rect, col: number, row: number): boolean {
  return col >= rect.x && col < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height
}

/** Return the value of the first target whose rect contains the point, or null
 *  when the click lands in a gutter/empty region. Pure so the app can feed it
 *  layout geometry and unit-test pointer routing without rendering. */
export function hitTest<T>(targets: readonly HitTarget<T>[], col: number, row: number): T | null {
  for (const target of targets) {
    if (contains(target.rect, col, row)) {
      return target.value
    }
  }
  return null
}
