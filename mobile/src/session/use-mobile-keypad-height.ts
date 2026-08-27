import { useRef, useState } from 'react'
import { PanResponder } from 'react-native'

import {
  ACCESSORY_GRID_VERTICAL_PADDING,
  ACCESSORY_KEY_HEIGHT,
  ACCESSORY_ROW_GAP
} from './mobile-session-command-input-styles'

const MIN_ROWS = 1
// A wrapping grid of N rows lays out as:
//   height(N) = N * keyHeight + (N - 1) * rowGap + verticalPadding
//             = N * (keyHeight + rowGap) - rowGap + verticalPadding
//             = N * stride - rowGap + verticalPadding
// so a "stride" of keyHeight + rowGap maps rows <-> pixels exactly, with no
// leftover gap or clipped row.
const ROW_STRIDE = ACCESSORY_KEY_HEIGHT + ACCESSORY_ROW_GAP
// Why: start at one row and grow to the real content height on the first
// onContentSizeChange, so we never flash empty space below a single-row grid.
const INITIAL_ROWS = 1

// Why: dragging the handle resizes between whole rows and snaps on release so
// it never sits on a half-clipped row or wastes vertical space. It also can't
// grow past the real content — once every button is visible the drag stops.
// Keyboard mode has a fixed height and does not use this.
export function useMobileKeypadHeight(): {
  height: number
  dragging: boolean
  measureContentHeight: (contentHeight: number) => void
  panResponder: ReturnType<typeof PanResponder.create>
} {
  const [height, setHeight] = useState(
    INITIAL_ROWS * ROW_STRIDE - ACCESSORY_ROW_GAP + ACCESSORY_GRID_VERTICAL_PADDING
  )
  const [dragging, setDragging] = useState(false)
  const maxRows = useRef(MIN_ROWS)
  const startHeight = useRef(0)
  const didInit = useRef(false)

  function rowsFor(pixels: number): number {
    return Math.max(
      MIN_ROWS,
      Math.round((pixels + ACCESSORY_ROW_GAP - ACCESSORY_GRID_VERTICAL_PADDING) / ROW_STRIDE)
    )
  }

  function snapped(scrollHeight: number): number {
    const rows = Math.max(MIN_ROWS, Math.min(maxRows.current || MIN_ROWS, rowsFor(scrollHeight)))
    return rows * ROW_STRIDE - ACCESSORY_ROW_GAP + ACCESSORY_GRID_VERTICAL_PADDING
  }

  function measureContentHeight(contentHeight: number): void {
    if (contentHeight <= 0) {
      return
    }
    maxRows.current = rowsFor(contentHeight)
    // Why: snap once on the first real layout so the starting height is a whole
    // number of rows; after that the user is in control (and we mustn't jump
    // while they're dragging).
    if (!didInit.current) {
      didInit.current = true
      setHeight(snapped(height))
    }
  }

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 6,
      onPanResponderGrant: () => {
        startHeight.current = height
        setDragging(true)
      },
      onPanResponderMove: (_event, gesture) => {
        // Why: the handle is on the top edge of the grid, so dragging up (negative dy) grows it.
        setHeight(snapped(startHeight.current - gesture.dy))
      },
      onPanResponderRelease: () => {
        setHeight((current) => snapped(current))
        setDragging(false)
      },
      onPanResponderTerminate: () => {
        setDragging(false)
      }
    })
  ).current

  return { height, dragging, measureContentHeight, panResponder }
}
