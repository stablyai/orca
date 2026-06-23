import { RuntimeClientError } from '../runtime-client'

export function validateExclusiveWindowTarget(
  windowId: number | undefined,
  windowIndex: number | undefined
): void {
  if (windowId !== undefined && windowIndex !== undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Window targeting accepts either --window-id or --window-index, not both'
    )
  }
}

export function validateElementOrCoordinates(
  actionName: 'Click' | 'Scroll',
  elementIndex: number | undefined,
  x: number | undefined,
  y: number | undefined
): void {
  const hasElement = elementIndex !== undefined
  const hasX = x !== undefined
  const hasY = y !== undefined
  if (!hasElement && !(hasX && hasY)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${actionName} requires --element-index or both --x and --y`
    )
  }
  if (hasX !== hasY) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${actionName} coordinates require both --x and --y`
    )
  }
  if (hasElement && (hasX || hasY)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${actionName} accepts either --element-index or coordinate flags, not both`
    )
  }
}

export function validateDragTarget(value: {
  fromElementIndex?: number
  toElementIndex?: number
  fromX?: number
  fromY?: number
  toX?: number
  toY?: number
}): void {
  const hasElementPair = value.fromElementIndex !== undefined && value.toElementIndex !== undefined
  const hasPartialElementPair =
    value.fromElementIndex !== undefined || value.toElementIndex !== undefined
  const coordinates = [value.fromX, value.fromY, value.toX, value.toY]
  const hasCoordinatePair = coordinates.every((coordinate) => coordinate !== undefined)
  const hasPartialCoordinatePair = coordinates.some((coordinate) => coordinate !== undefined)
  if (hasElementPair && hasCoordinatePair) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Drag accepts either element indexes or coordinate flags, not both'
    )
  }
  if (hasPartialElementPair && !hasElementPair) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Drag element targeting requires both --from-element-index and --to-element-index'
    )
  }
  if (hasPartialCoordinatePair && !hasCoordinatePair) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Drag coordinates require --from-x, --from-y, --to-x, and --to-y'
    )
  }
  if (!hasElementPair && !hasCoordinatePair) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Drag requires --from-element-index and --to-element-index, or all coordinate flags'
    )
  }
}

export function validateMouseButton(mouseButton: string | undefined): void {
  if (
    mouseButton !== undefined &&
    mouseButton !== 'left' &&
    mouseButton !== 'right' &&
    mouseButton !== 'middle'
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Unsupported --mouse-button; expected left, right, or middle'
    )
  }
}

export function validateScrollDirection(direction: string): void {
  if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Unsupported --direction; expected up, down, left, or right'
    )
  }
}
