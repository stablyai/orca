// Round-trip oracle for serialize-grid.differential.fuzz.test.ts: drives one
// source terminal through a fuzz case, serializes it with every supplied
// SerializeAddon build at each checkpoint, replays each output into a fresh
// terminal of the source's size and reports the first cell/cursor/mode diff.
import { Terminal } from '@xterm/headless'
import { createRequire } from 'node:module'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { activateOrcaTerminalUnicodeProvider } from '../../shared/terminal-unicode-provider'
import {
  readSavedCursorRegister,
  serializeWithAbsoluteCursor
} from '../../shared/terminal-serialize-absolute-cursor'
import type { SerializeFuzzCase } from './serialize-grid-fuzz-stream'
import {
  serializedNormalStart,
  variantOverlong,
  variantTrailingBackgroundRows
} from './serialize-grid-variant-scope'
import type { GridDiff } from './serialize-grid-cell-descriptors'
import {
  bufferRows,
  cellDescriptor,
  CLIPPED,
  compareRowSets
} from './serialize-grid-cell-descriptors'

export type NamedSerializer = { name: string; create: () => SerializeAddon }

/** Loads a patched build's lib/addon-serialize.js (see config/scripts/build-serialize-addon-at-ref.mjs). */
function loadSerializerBuild(name: string, path: string): NamedSerializer {
  const loaded: { SerializeAddon: typeof SerializeAddon } = createRequire(import.meta.url)(path)
  return { name, create: () => new loaded.SerializeAddon() }
}

export function loadOldSerializer(path: string): NamedSerializer {
  return loadSerializerBuild('old', path)
}

// ORCA_NEW_SERIALIZE_ADDON compares two arbitrary refs without reinstalling node_modules.
export const NEW_SERIALIZER: NamedSerializer = process.env.ORCA_NEW_SERIALIZE_ADDON
  ? loadSerializerBuild('new', process.env.ORCA_NEW_SERIALIZE_ADDON)
  : { name: 'new', create: () => new SerializeAddon() }

export type { GridDiff } from './serialize-grid-cell-descriptors'

export type SerializeCheckResult = {
  stepIndex: number
  /** Per serialize variant: some line in the serialized range is wider than the grid. */
  overlong: boolean[]
  /** Per serialize variant: a blank background-colored row follows the last row with text. */
  trailingBackgroundRows: boolean[]
  /** outputs[serializerName][variant] */
  outputs: Record<string, string[]>
  /** First I2 diff per serializer (cells, cursor, buffer, modes); null = faithful. */
  gridDiff: Record<string, GridDiff | null>
  /** isWrapped diffs are reported apart: they never change what is painted. */
  wrapDiff: Record<string, GridDiff | null>
  clippedWideCells: number
}

const REPLAY_SCROLLBACK = 20_000

export function createFuzzTerminal(opts: {
  cols: number
  rows: number
  scrollback: number
  conpty?: boolean
}): Terminal {
  const terminal = new Terminal({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback,
    allowProposedApi: true,
    logLevel: 'off',
    vtExtensions: { kittyKeyboard: true },
    ...(opts.conpty ? { windowsPty: { backend: 'conpty', buildNumber: 19041 } } : {})
  })
  terminal.loadAddon(new Unicode11Addon())
  activateOrcaTerminalUnicodeProvider(terminal)
  return terminal
}

/** Thrown when xterm itself crashes on a fuzz stream; unrelated to serialization. */
export class XtermWriteCrash extends Error {}

/** The private xterm core members the oracle needs: sync writes and the active DECSTBM region. */
type XtermCoreInternals = {
  writeSync: (data: string) => void
  region: { top: number; bottom: number }
}

function readRegion(buffer: unknown): { top: number; bottom: number } {
  if (typeof buffer !== 'object' || buffer === null) {
    return { top: -1, bottom: -1 }
  }
  const top = 'scrollTop' in buffer && typeof buffer.scrollTop === 'number' ? buffer.scrollTop : -1
  const bottom =
    'scrollBottom' in buffer && typeof buffer.scrollBottom === 'number' ? buffer.scrollBottom : -1
  return { top, bottom }
}

function readXtermCore(terminal: Terminal): XtermCoreInternals {
  const core: unknown = '_core' in terminal ? terminal._core : undefined
  if (typeof core !== 'object' || core === null || !('writeSync' in core)) {
    throw new Error('headless xterm core without writeSync')
  }
  const { writeSync } = core
  if (typeof writeSync !== 'function') {
    throw new Error('headless xterm core without writeSync')
  }
  return {
    writeSync: (data) => writeSync.call(core, data),
    region: readRegion('buffer' in core ? core.buffer : undefined)
  }
}

// Why sync: an xterm parser exception inside async write() never resolves its callback and hangs the sweep.
export function writeTerminal(terminal: Terminal, data: string): void {
  // Headless Terminal's core exposes writeSync(data); the public API only has async write().
  const { writeSync } = readXtermCore(terminal)
  try {
    writeSync(data)
  } catch (error) {
    throw new XtermWriteCrash(String(error))
  }
}

function coreRegion(terminal: Terminal): { top: number; bottom: number } {
  // xterm keeps DECSTBM on the private _core.buffer.
  return readXtermCore(terminal).region
}

function modeState(terminal: Terminal): string {
  const { synchronizedOutputMode: _sync, ...modes } = terminal.modes
  return JSON.stringify({ ...modes, region: coreRegion(terminal) })
}

async function compareReplay(
  source: Terminal,
  output: string,
  scrollback: number | undefined
): Promise<{ grid: GridDiff | null; wrap: GridDiff | null }> {
  const { cols, rows } = source
  const replay = createFuzzTerminal({ cols, rows, scrollback: REPLAY_SCROLLBACK })
  try {
    try {
      writeTerminal(replay, output)
    } catch (error) {
      return { grid: { stage: 'replay-crash', expected: null, actual: String(error) }, wrap: null }
    }
    const src = source.buffer.active
    const dst = replay.buffer.active
    const normalStart = serializedNormalStart(source, scrollback)
    const grid =
      (src.type === dst.type
        ? null
        : { stage: 'active-buffer', expected: src.type, actual: dst.type }) ??
      compareRowSets(
        'visible-grid',
        bufferRows(src, src.baseY, src.baseY + rows, cols),
        bufferRows(dst, dst.baseY, dst.baseY + rows, cols)
      ) ??
      compareRowSets(
        'normal-buffer',
        bufferRows(source.buffer.normal, normalStart, source.buffer.normal.length, cols),
        bufferRows(replay.buffer.normal, 0, replay.buffer.normal.length, cols)
      ) ??
      (src.cursorX === dst.cursorX && src.cursorY === dst.cursorY
        ? null
        : {
            stage: 'cursor',
            expected: [src.cursorX, src.cursorY],
            actual: [dst.cursorX, dst.cursorY]
          }) ??
      (modeState(source) === modeState(replay)
        ? null
        : { stage: 'modes', expected: modeState(source), actual: modeState(replay) })
    const srcWraps = Array.from({ length: rows }, (_, y) =>
      Boolean(src.getLine(src.baseY + y)?.isWrapped)
    )
    const dstWraps = Array.from({ length: rows }, (_, y) =>
      Boolean(dst.getLine(dst.baseY + y)?.isWrapped)
    )
    const wrap =
      JSON.stringify(srcWraps) === JSON.stringify(dstWraps)
        ? null
        : { stage: 'visible-wraps', expected: srcWraps, actual: dstWraps }
    return { grid, wrap }
  } finally {
    replay.dispose()
  }
}

function countClippedWideCells(terminal: Terminal): number {
  const buffer = terminal.buffer.active
  let count = 0
  for (let y = 0; y < buffer.length; y++) {
    if (cellDescriptor(buffer.getLine(y), terminal.cols - 1, terminal.cols) === CLIPPED) {
      count++
    }
  }
  return count
}

/** Variant 0 is the production snapshot path; the others pin byte identity of the raw API. */
function serializeVariants(
  addon: SerializeAddon,
  source: Terminal,
  scrollback: number | undefined,
  rangeRow: number
): string[] {
  return [
    serializeWithAbsoluteCursor(addon, source, { scrollback }, readSavedCursorRegister(source)),
    addon.serialize(),
    addon.serialize({
      range: { start: rangeRow, end: Math.min(rangeRow + 2, source.buffer.normal.length - 1) },
      excludeAltBuffer: true,
      excludeModes: true
    })
  ]
}

export type SerializeCaseRun = {
  checks: SerializeCheckResult[]
  /** xterm threw while the SOURCE parsed the stream; later checkpoints are skipped. */
  sourceCrash: string | null
}

export async function runSerializeFuzzCase(
  testCase: SerializeFuzzCase,
  serializers: readonly NamedSerializer[]
): Promise<SerializeCaseRun> {
  const source = createFuzzTerminal({
    cols: testCase.cols,
    rows: testCase.rows,
    scrollback: testCase.sourceScrollback,
    conpty: testCase.category === 'conpty'
  })
  const addons = serializers.map((s) => ({ name: s.name, addon: s.create() }))
  for (const { addon } of addons) {
    source.loadAddon(addon)
  }
  const results: SerializeCheckResult[] = []
  try {
    for (const [stepIndex, step] of testCase.steps.entries()) {
      if (step.kind !== 'check') {
        try {
          if (step.kind === 'write') {
            writeTerminal(source, step.data)
          } else {
            source.resize(step.cols, step.rows)
          }
        } catch (error) {
          return { checks: results, sourceCrash: String(error) }
        }
        continue
      }
      const rangeRow = Math.floor(source.buffer.normal.length / 2)
      const result: SerializeCheckResult = {
        stepIndex,
        overlong: variantOverlong(source, step.scrollback, rangeRow),
        trailingBackgroundRows: variantTrailingBackgroundRows(source, step.scrollback, rangeRow),
        outputs: {},
        gridDiff: {},
        wrapDiff: {},
        clippedWideCells: countClippedWideCells(source)
      }
      for (const { name, addon } of addons) {
        let outputs: string[]
        try {
          outputs = serializeVariants(addon, source, step.scrollback, rangeRow)
        } catch (error) {
          result.outputs[name] = [`throw:${String(error)}`]
          result.gridDiff[name] = {
            stage: 'serialize-throws',
            expected: null,
            actual: String(error)
          }
          result.wrapDiff[name] = null
          continue
        }
        const { grid, wrap } = await compareReplay(source, outputs[0]!, step.scrollback)
        result.outputs[name] = outputs
        result.gridDiff[name] = grid
        result.wrapDiff[name] = wrap
      }
      results.push(result)
    }
  } finally {
    source.dispose()
  }
  return { checks: results, sourceCrash: null }
}

export type Verdict = 'i1-bytes-differ' | 'regression' | 'fixed' | 'both-fail' | 'new-fail'

/** I1 byte identity, then I2/I3 classification; single-serializer runs only report new-fail. */
export function i1Applies(check: SerializeCheckResult): boolean[] {
  return check.overlong.map((overlong, v) => !overlong && !check.trailingBackgroundRows[v])
}

/** Per variant: I1 applies, yet the bytes changed. */
export function i1BytesDifferByVariant(check: SerializeCheckResult): boolean[] {
  return i1Applies(check).map(
    (applies, v) => applies && check.outputs.old![v] !== check.outputs.new![v]
  )
}

export function verdicts(check: SerializeCheckResult, differential: boolean): Verdict[] {
  const out: Verdict[] = []
  const newFail = check.gridDiff.new !== null
  if (!differential) {
    return newFail ? ['new-fail'] : []
  }
  const oldFail = check.gridDiff.old !== null
  if (i1BytesDifferByVariant(check).some(Boolean)) {
    out.push('i1-bytes-differ')
  }
  if (newFail && !oldFail) {
    out.push('regression')
  } else if (!newFail && oldFail) {
    out.push('fixed')
  } else if (newFail && oldFail) {
    out.push('both-fail')
  }
  return out
}
