import type { Terminal } from '@xterm/headless'
import {
  originTerminalCore,
  readOriginLineAttachment,
  type OriginBuffer,
  type OriginBufferLine,
  type OriginLineMethods
} from './headless-content-origin-lines'
import type { HeadlessContentOrigins } from './headless-content-origins'
import type {
  TerminalContentOrigin,
  TerminalOriginRun
} from '../../../shared/terminal/output/terminal-content-origin'

const NATIVE_METHODS = [
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
  'copyCellsFrom',
  'setCellFromCodepoint',
  'addCodepointToCell',
  'hasContent',
  'getWidth',
  'getString',
  'translateToString'
] as const

type NativeOriginLine = {
  prototype: object
  methods: Readonly<Record<string, unknown>>
  nullCellFactory: OriginBuffer['getNullCell']
  blankFactory: OriginBuffer['getBlankLine']
}

function dataMethod(object: object, name: string): unknown {
  if (Object.hasOwn(object, name)) {
    return undefined
  }
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object), name)
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'function'
    ? descriptor.value
    : undefined
}

/** The private native factory supplies identities, never a resident row or origin. */
export function captureNativeOriginLine(terminal: Terminal): NativeOriginLine | undefined {
  const buffers = originTerminalCore(terminal)?.buffers
  if (!buffers) {
    return undefined
  }
  const factory = dataMethod(buffers.normal, 'getBlankLine')
  const nullCell = dataMethod(buffers.normal, 'getNullCell')
  if (
    !factory ||
    !nullCell ||
    factory !== dataMethod(buffers.alt, 'getBlankLine') ||
    nullCell !== dataMethod(buffers.alt, 'getNullCell')
  ) {
    return undefined
  }
  try {
    // The native factory resets only its scratch null-cell attributes.
    const probe = buffers.normal.getBlankLine()
    if (!canonicalEmptyOriginLine(probe)) {
      return undefined
    }
    const prototype = Object.getPrototypeOf(probe)
    const methods: Record<string, unknown> = {}
    for (const name of NATIVE_METHODS) {
      if (name === 'set' && !probe.set) {
        continue
      }
      const method = dataMethod(probe, name)
      if (!method) {
        return undefined
      }
      methods[name] = method
    }
    return {
      prototype,
      methods: Object.freeze(methods),
      blankFactory: buffers.normal.getBlankLine,
      nullCellFactory: buffers.normal.getNullCell
    }
  } catch {
    return undefined
  }
}

export function nativeOriginFactory(
  buffer: OriginBuffer,
  factory: OriginBuffer['getBlankLine'],
  native: NativeOriginLine | undefined
): boolean {
  return (
    !!native &&
    factory === native.blankFactory &&
    dataMethod(buffer, 'getNullCell') === native.nullCellFactory
  )
}

export function compatibleOriginLine(
  line: OriginBufferLine,
  native: NativeOriginLine | undefined,
  originals?: OriginLineMethods
): boolean {
  if (!native) {
    return false
  }
  const prototype = Object.getPrototypeOf(line)
  if (
    prototype !== native.prototype &&
    !(originals && Object.getPrototypeOf(prototype) === native.prototype)
  ) {
    return false
  }
  for (const name of NATIVE_METHODS) {
    const method = native.methods[name]
    if (name === 'set' && !method) {
      continue
    }
    if (Object.hasOwn(line, name)) {
      return false
    }
    const descriptor = Object.getOwnPropertyDescriptor(native.prototype, name)
    if (!descriptor || !('value' in descriptor) || descriptor.value !== method) {
      return false
    }
    const original = originals && Object.getOwnPropertyDescriptor(originals, name)
    if (original ? original.value !== method : line[name] !== method) {
      return false
    }
  }
  return true
}

export function canonicalEmptyOriginLine(line: OriginBufferLine): boolean {
  for (let column = 0; column < line.length; column++) {
    if (line.hasContent(column) || line.getWidth(column) !== 1) {
      return false
    }
  }
  return true
}

export function visitOriginLines(
  terminal: Terminal,
  visit: (line: OriginBufferLine) => boolean
): boolean {
  const buffers = originTerminalCore(terminal)?.buffers
  if (!buffers) {
    return false
  }
  for (const buffer of [buffers.normal, buffers.alt]) {
    for (let index = 0; index < buffer.lines.length; index++) {
      const line = buffer.lines.get(index)
      if (!line || !visit(line)) {
        return false
      }
    }
  }
  return true
}

export function initiallyEmptyOriginBuffers(
  terminal: Terminal,
  owner: HeadlessContentOrigins,
  native: NativeOriginLine | undefined
): boolean {
  return visitOriginLines(terminal, (line) => {
    const state = readOriginLineAttachment(line)
    return (
      state?.owner === owner &&
      compatibleOriginLine(line, native, state.originals) &&
      canonicalEmptyOriginLine(line)
    )
  })
}

export function seedUniformOriginLine(
  line: OriginBufferLine,
  owner: HeadlessContentOrigins,
  origin: TerminalContentOrigin
): void {
  const state = readOriginLineAttachment(line)
  if (state?.owner !== owner) {
    return
  }
  const runs: TerminalOriginRun[] = []
  for (let column = 0; column < line.length; column++) {
    if (!line.hasContent(column)) {
      continue
    }
    const end = Math.min(line.length, column + line.getWidth(column))
    const previous = runs.at(-1)
    if (previous?.end === column) {
      previous.end = end
    } else {
      runs.push({ start: column, end, origin })
    }
  }
  state.runs = runs
}
