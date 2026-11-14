import {
  readOriginLineAttachment,
  type OriginBufferLine,
  type OriginLineMethods
} from './headless-content-origin-lines'

const LINE_METHOD_NAMES = [
  'loadCell',
  'setCell',
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

/** Shared implementations are installed only on rows attached to an emulator. */
export const ORIGIN_LINE_HOOKS: OriginLineMethods = {
  loadCell(this: OriginBufferLine, index, cell) {
    return readOriginLineAttachment(this)!.owner.cells.load(this, index, cell)
  },
  setCell(this: OriginBufferLine, index, cell) {
    readOriginLineAttachment(this)!.owner.setCell(this, index, cell)
  },
  set(this: OriginBufferLine, index, cell) {
    const state = readOriginLineAttachment(this)!
    state.originals.set.call(this, index, cell)
    state.owner.writeCell(this, index)
  },
  insertCells(this: OriginBufferLine, position, count, fill) {
    readOriginLineAttachment(this)!.owner.edits.insert(this, position, count, fill)
  },
  deleteCells(this: OriginBufferLine, position, count, fill) {
    readOriginLineAttachment(this)!.owner.edits.remove(this, position, count, fill)
  },
  replaceCells(this: OriginBufferLine, start, end, fill, protect) {
    readOriginLineAttachment(this)!.owner.edits.replace(this, start, end, fill, protect)
  },
  fill(this: OriginBufferLine, cell, protect) {
    readOriginLineAttachment(this)!.owner.edits.fill(this, cell, protect)
  },
  resize(this: OriginBufferLine, cols, cell) {
    return readOriginLineAttachment(this)!.owner.edits.resize(this, cols, cell)
  },
  copyFrom(this: OriginBufferLine, source, blank) {
    readOriginLineAttachment(this)!.owner.copyFrom(this, source, blank)
  },
  clone(this: OriginBufferLine, blank) {
    return readOriginLineAttachment(this)!.owner.clone(this, blank)
  },
  copyCellsFrom(this: OriginBufferLine, source, from, to, count, reverse) {
    readOriginLineAttachment(this)!.owner.copyCells(this, source, from, to, count, reverse)
  }
}
export const { set: _optionalSetHook, ...REQUIRED_ORIGIN_LINE_HOOKS } = ORIGIN_LINE_HOOKS

const hookPrototypes = new WeakMap<
  object,
  { prototype: object; originals: Readonly<OriginLineMethods> }
>()

export function prepareOriginLineHookPrototype(
  line: OriginBufferLine,
  originals: OriginLineMethods
): object | undefined {
  const nativePrototype = Object.getPrototypeOf(line)
  if (!nativePrototype) {
    return undefined
  }
  const cached = hookPrototypes.get(nativePrototype)
  for (const name of LINE_METHOD_NAMES) {
    if (Object.hasOwn(line, name)) {
      return undefined
    }
    const descriptor = Object.getOwnPropertyDescriptor(nativePrototype, name)
    if (name === 'set' && !originals.set && !(name in nativePrototype)) {
      if (cached?.originals.set) {
        return undefined
      }
      continue
    }
    if (
      !descriptor ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'function' ||
      descriptor.value !== originals[name] ||
      (cached && cached.originals[name] !== originals[name])
    ) {
      return undefined
    }
  }
  if (cached) {
    return cached.prototype
  }
  const prototype = Object.create(nativePrototype)
  for (const name of LINE_METHOD_NAMES) {
    if (name !== 'set' || originals.set) {
      Object.defineProperty(prototype, name, {
        value: ORIGIN_LINE_HOOKS[name],
        writable: true,
        configurable: true
      })
    }
  }
  hookPrototypes.set(nativePrototype, { prototype, originals: Object.freeze({ ...originals }) })
  return prototype
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
