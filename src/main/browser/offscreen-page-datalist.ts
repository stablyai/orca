import type {
  OffscreenPageDatalistItem,
  OffscreenPageUserInput
} from '../../shared/offscreen-page-protocol'

type Rect = { x: number; y: number; width: number; height: number }

// Electron's AutofillPopup metrics, in DIPs.
const ROW_HEIGHT = 24
const BORDER = 1

/** The popup as the page lays it out, in page DIPs. */
export type OffscreenPageDatalistPopup = {
  rect: Rect
  items: OffscreenPageDatalistItem[]
  selected: number | null
}

export type OffscreenPageDatalistMirror = {
  /** Feeds a paint that carried no texture: Electron's only sign of its datalist popup. */
  onBitmapPaint(dirty: Rect, imageEmpty: boolean, viewSize: { width: number; height: number }): void
  setItems(items: OffscreenPageDatalistItem[]): void
  /**
   * Tracks the selection the popup makes from this user input. Returns true when the input is the
   * popup's (its keys, or the pointer over it), which only sendInputEvent delivers there.
   */
  onUserInput(input: OffscreenPageUserInput): boolean
}

/**
 * Mirrors Electron's datalist popup (AutofillPopupView) for an offscreen page. The popup still
 * lives in the page and takes the user's clicks and keys natively; shared-texture frames just
 * never contain its pixels, so Orca draws a replica from this state.
 */
export function createOffscreenPageDatalistMirror(args: {
  /** Physical pixels per page DIP; paint rects arrive in pixels. */
  scaleFactor: number
  queryItems: () => void
  onChange: (popup: OffscreenPageDatalistPopup | null) => void
}): OffscreenPageDatalistMirror {
  let popup: OffscreenPageDatalistPopup | null = null
  // Why: typing re-creates the popup (a full-view paint, then the new rect), which drops selection.
  let recreating = false

  const emit = (): void => args.onChange(popup && { ...popup })
  const select = (line: number | null): void => {
    if (popup && popup.selected !== line) {
      popup.selected = line
      emit()
    }
  }
  const lineCount = (): number =>
    popup ? Math.max(0, Math.round((popup.rect.height - 2 * BORDER) / ROW_HEIGHT)) : 0
  // AutofillPopup::LineFromY, for a y inside the popup.
  const lineFromY = (y: number): number => {
    const count = lineCount()
    for (let i = 0; i < count; i += 1) {
      if (y <= BORDER + (i + 1) * ROW_HEIGHT) {
        return i
      }
    }
    return count - 1
  }

  return {
    onBitmapPaint(dirty, imageEmpty, viewSize) {
      // An empty image means no popup is left to composite: it closed.
      if (imageEmpty) {
        recreating = false
        if (popup) {
          popup = null
          emit()
        }
        return
      }
      const s = args.scaleFactor
      // Why both units: Electron invalidates the whole view in DIPs but popup rects in pixels.
      const fullView =
        dirty.x === 0 &&
        dirty.y === 0 &&
        ((dirty.width === viewSize.width && dirty.height === viewSize.height) ||
          (dirty.width === viewSize.width * s && dirty.height === viewSize.height * s))
      if (fullView) {
        recreating = popup !== null
        return
      }
      const rect = {
        x: dirty.x / s,
        y: dirty.y / s,
        width: dirty.width / s,
        height: dirty.height / s
      }
      if (!popup || recreating) {
        recreating = false
        popup = { rect, items: popup?.items ?? [], selected: null }
        args.queryItems()
      } else {
        popup.rect = rect
      }
      emit()
    },
    setItems(items) {
      if (popup) {
        popup.items = items
        emit()
      }
    },
    onUserInput(input) {
      if (!popup) {
        return false
      }
      if (input.kind === 'mouse') {
        const { x, y, width, height } = popup.rect
        const inside = input.x >= x && input.x < x + width && input.y >= y && input.y < y + height
        // Why no clearing outside: the offscreen popup only ever sees the pointer over itself.
        if (inside && input.type === 'mouseMove') {
          select(lineFromY(input.y - y))
        }
        return inside && input.type !== 'mouseLeave'
      }
      if (input.kind !== 'key') {
        return false
      }
      // AutofillPopupView::HandleKeyPressEvent; keyups follow their keydown's route.
      const last = lineCount() - 1
      const selected = popup.selected
      const keyDown = input.type === 'keyDown'
      switch (input.key) {
        case 'ArrowUp':
          if (keyDown) {
            const previous = (selected ?? 0) - 1
            select(previous < 0 ? last : previous)
          }
          return true
        case 'ArrowDown':
          if (keyDown) {
            const next = selected === null ? 0 : selected + 1
            select(next > last ? 0 : next)
          }
          return true
        case 'PageUp':
          if (keyDown) {
            select(0)
          }
          return true
        case 'PageDown':
          if (keyDown) {
            select(last)
          }
          return true
        case 'Escape':
          return true
        case 'Enter':
        case 'Tab':
          // Only a selected line is accepted; otherwise the key belongs to the page as usual.
          return selected !== null
        default:
          return false
      }
    }
  }
}
