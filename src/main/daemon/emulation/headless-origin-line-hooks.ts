import type { OriginBufferLine, OriginLineMethods } from './headless-content-origin-lines'

type OriginLineHandlers = {
  [K in keyof OriginLineMethods]: (
    line: OriginBufferLine,
    ...args: Parameters<OriginLineMethods[K]>
  ) => ReturnType<OriginLineMethods[K]>
}

const LINE_METHOD_NAMES = [
  'loadCell',
  'setCell',
  'setCellFromCodepoint',
  'addCodepointToCell',
  'set',
  'insertCells',
  'deleteCells',
  'replaceCells',
  'fill',
  'resize',
  'copyFrom',
  'clone',
  'copyCellsFrom'
] as const

/** One method target per emulator; original methods are captured before any hook is installed. */
export function createOriginLineHooks(handlers: OriginLineHandlers): OriginLineMethods {
  return {
    loadCell(this: OriginBufferLine, index, cell) {
      return handlers.loadCell(this, index, cell)
    },
    setCell(this: OriginBufferLine, index, cell) {
      handlers.setCell(this, index, cell)
    },
    setCellFromCodepoint(this: OriginBufferLine, index, code, width, attrs) {
      handlers.setCellFromCodepoint(this, index, code, width, attrs)
    },
    addCodepointToCell(this: OriginBufferLine, index, code, width) {
      handlers.addCodepointToCell(this, index, code, width)
    },
    set(this: OriginBufferLine, index, cell) {
      handlers.set(this, index, cell)
    },
    insertCells(this: OriginBufferLine, position, count, fill) {
      handlers.insertCells(this, position, count, fill)
    },
    deleteCells(this: OriginBufferLine, position, count, fill) {
      handlers.deleteCells(this, position, count, fill)
    },
    replaceCells(this: OriginBufferLine, start, end, fill, protect) {
      handlers.replaceCells(this, start, end, fill, protect)
    },
    fill(this: OriginBufferLine, cell, protect) {
      handlers.fill(this, cell, protect)
    },
    resize(this: OriginBufferLine, cols, cell) {
      return handlers.resize(this, cols, cell)
    },
    copyFrom(this: OriginBufferLine, source, blank) {
      handlers.copyFrom(this, source, blank)
    },
    clone(this: OriginBufferLine, blank) {
      return handlers.clone(this, blank)
    },
    copyCellsFrom(this: OriginBufferLine, source, from, to, count, reverse) {
      handlers.copyCellsFrom(this, source, from, to, count, reverse)
    }
  }
}

export function captureOriginLineMethods(
  line: OriginBufferLine,
  shared?: OriginLineMethods
): OriginLineMethods {
  if (shared) {
    let matches = true
    for (const name of LINE_METHOD_NAMES) {
      if (line[name] !== shared[name]) {
        matches = false
        break
      }
    }
    if (matches) {
      return shared
    }
  }
  return {
    loadCell: line.loadCell,
    setCell: line.setCell,
    setCellFromCodepoint: line.setCellFromCodepoint,
    addCodepointToCell: line.addCodepointToCell,
    set: line.set,
    insertCells: line.insertCells,
    deleteCells: line.deleteCells,
    replaceCells: line.replaceCells,
    fill: line.fill,
    resize: line.resize,
    copyFrom: line.copyFrom,
    clone: line.clone,
    copyCellsFrom: line.copyCellsFrom
  }
}
