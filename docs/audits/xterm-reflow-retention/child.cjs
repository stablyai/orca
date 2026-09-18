const assert = require('node:assert/strict')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')
const input = JSON.parse(process.argv[2])
const candidate = require('./install-candidate.cjs')('@xterm/headless', !!input.candidate)
const { HeadlessEmulator } = require(
  require('node:path').join(process.env.ORCA_REFLOW_BUNDLE_DIR, 'emulator.cjs')
)
const { oldCols, newCols, capacity, fillCols = oldCols } = input
assert(oldCols <= 200 && capacity <= 5000 && newCols >= 2)
assert((oldCols / newCols) * capacity <= 150000)
const rows = 24
const emulator = new HeadlessEmulator({ cols: oldCols, rows, scrollback: capacity - rows })
let wrappedText
if (input.wrapped) {
  wrappedText = Array.from({ length: (oldCols * (capacity - 1)) / 8 }, (_, index) =>
    String(index).padStart(8, '0')
  ).join('')
  assert(emulator.writeSync(`${wrappedText}\r\n`))
} else {
  for (let row = 0; row < capacity; row++) {
    assert(
      emulator.writeSync(
        `${String(row).padStart(6, '0').slice(0, fillCols).padEnd(fillCols, 'x')}\r\n`
      )
    )
  }
}
const buffer = emulator.terminal._core._bufferService.buffer
const memory = () => {
  global.gc()
  return process.memoryUsage()
}
const before = memory()
const initialLength = buffer.lines.length
const expectedNewRows = (capacity - 1) * (Math.ceil(fillCols / newCols) - 1)
let createdRows = 0
let createdCellBytes = 0
const observations = []
const blank = buffer.getBlankLine
const trim = buffer.lines.onTrimEmitter.fire
function sample(phase) {
  const usage = memory()
  assert(usage.rss < 240 * 1024 * 1024, 'Bounded fixture RSS safety ceiling')
  const negativeSlots = Object.keys(buffer.lines._array).filter((key) => Number(key) < 0)
  observations.push({
    phase,
    createdRows,
    createdCellBytes,
    bufferLength: buffer.lines.length,
    negativeSlotCount: negativeSlots.length,
    negativeCellBytes: negativeSlots.reduce(
      (sum, key) => sum + (buffer.lines._array[key]?._data.byteLength ?? 0),
      0
    ),
    ...usage
  })
}
buffer.getBlankLine = function (...args) {
  const line = blank.apply(this, args)
  createdRows++
  createdCellBytes += line._data.byteLength
  if (createdRows % 20000 === 0) {
    sample('building-insertion-list')
  }
  return line
}
buffer.lines.onTrimEmitter.fire = function (...args) {
  sample('before-final-trim-notification')
  return trim.apply(this, args)
}
const started = performance.now()
emulator.resize(newCols, rows)
const elapsedMs = performance.now() - started
buffer.getBlankLine = blank
buffer.lines.onTrimEmitter.fire = trim
assert.equal(createdRows, Math.max(0, expectedNewRows))
assert.equal(buffer.lines.length, capacity)
assert.equal(emulator.getAppliedSize().cols, newCols)
sample('after-resize')
setTimeout(() => {
  sample('after-next-turn')
  const wrappedParity =
    wrappedText === undefined
      ? undefined
      : (() => {
          const expected = [...wrappedText.match(new RegExp(`.{1,${newCols}}`, 'g')), ''].slice(
            -capacity
          )
          const actual = emulator.getBufferTailLines(capacity)
          return {
            expectedFirst: expected[0],
            actualFirst: actual[0],
            mismatches: actual
              .flatMap((line, index) =>
                line === expected[index] ? [] : [{ index, expected: expected[index], actual: line }]
              )
              .slice(0, 5)
          }
        })()
  const result = {
    input,
    candidate,
    node: process.version,
    initialLength,
    finalLength: buffer.lines.length,
    createdRows,
    createdCellBytes,
    elapsedMs,
    before,
    observations,
    resourceUsage: process.resourceUsage(),
    tail: emulator.getBufferTailLines(3),
    wrappedParity
  }
  emulator.dispose()
  process.stdout.write(`${JSON.stringify(result)}\n`)
}, 20)
setTimeout(() => process.exit(2), 12000).unref()
