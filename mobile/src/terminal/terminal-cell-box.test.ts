import { describe, expect, it } from 'vitest'
import { readTerminalCellBox } from './terminal-cell-box'

// 23 device px at DPR 3: the WebGL renderer's 13px cell on the emulator.
const CELL_1X = { fontScale: 1, cellWidth: 23 / 3, cellHeight: 15 }

describe('readTerminalCellBox', () => {
  it('reads nothing from a notify without a cell box', () => {
    expect(readTerminalCellBox({ type: 'web-ready' })).toBeNull()
  })

  it('reads a well-formed box and rejects a malformed one', () => {
    expect(readTerminalCellBox({ cellBox: CELL_1X })).toEqual(CELL_1X)
    expect(readTerminalCellBox({ cellBox: { ...CELL_1X, cellWidth: 0 } })).toBeNull()
    expect(readTerminalCellBox({ cellBox: [CELL_1X] })).toBeNull()
  })
})
