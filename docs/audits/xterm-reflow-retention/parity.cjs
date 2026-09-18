const assert = require('node:assert/strict')
const fs = require('node:fs')
const crypto = require('node:crypto')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
const installCandidate = require('./install-candidate.cjs')
const capacity = 128
const rows = 8
const oldCols = 80
const encoded = (count) =>
  Array.from({ length: count }, (_, index) => String(index).padStart(8, '0')).join('')
const scenarios = [
  { name: 'oversized-wrapped', data: `${encoded((capacity - 1) * 10)}\r\n`, oracle: true },
  {
    name: 'rotated-ring',
    data: `${'prefix\r\n'.repeat(37)}${encoded((capacity - 1) * 10)}\r\n`,
    oracle: true
  },
  {
    name: 'wide-combining-color',
    data: `\x1b[31;44;1m${'a界e\u0301BC界'.repeat(1000)}\x1b[0m\r\n`,
    oracle: true
  },
  { name: 'wide-boundary', data: `${'123456界a'.repeat(1100)}\r\n`, newCols: 9, oracle: true },
  { name: 'multiple-wrapped-groups', data: `${encoded(700)}\r\n${encoded(540)}\r\n`, oracle: true },
  {
    name: 'reflow-cursor-enabled',
    data: encoded((capacity - 1) * 10),
    reflowCursorLine: true,
    oracle: true
  },
  { name: 'cursor-group-skipped', data: encoded((capacity - 1) * 10) },
  {
    name: 'hard-newline-overflow',
    data: Array.from(
      { length: capacity },
      (_, i) => `${String(i).padStart(8, '0')}${'x'.repeat(72)}\r\n`
    ).join(''),
    oracle: true
  },
  { name: 'small-wrapped-no-trim', data: `${encoded(8)}\r\n`, oracle: true },
  { name: 'unfilled-viewport', data: 'first\r\n1234567890123\r\nlast', oracle: true },
  { name: 'alternate-buffer', data: `normal\r\n\x1b[?1049h${encoded(80)}\r\n`, alt: true },
  { name: 'same-size', data: `${encoded((capacity - 1) * 10)}\r\n`, newCols: 80 },
  { name: 'two-column-api-floor', data: `${encoded(400)}\r\n`, newCols: 2, oracle: true },
  {
    name: 'twenty-column-runtime-floor',
    data: `${encoded((capacity - 1) * 10)}\r\n`,
    newCols: 20,
    oracle: true
  }
]
function run(Terminal, scenario, large = false) {
  const term = new Terminal({
    cols: oldCols,
    rows,
    scrollback: (large ? 20000 : capacity) - rows,
    allowProposedApi: true,
    logLevel: 'off',
    reflowCursorLine: !!scenario.reflowCursorLine
  })
  term._core.writeSync(scenario.data)
  const buffer = term._core._bufferService.buffer
  const originalLength = buffer.lines.length
  const originalStart = buffer.lines._startIndex
  const markers = [0, Math.floor(originalLength / 2), originalLength - 2, originalLength - 1].map(
    (y) => buffer.addMarker(y)
  )
  const events = []
  let invalidWrites = 0
  const set = buffer.lines.set
  buffer.lines.set = function (index, line) {
    if (index < 0) {
      invalidWrites++
    }
    return set.call(this, index, line)
  }
  const listeners = [
    buffer.lines.onInsert((event) => events.push(['insert', event.index, event.amount])),
    buffer.lines.onTrim((amount) => events.push(['trim', amount]))
  ]
  function snapshot() {
    const data = []
    for (let y = 0; y < buffer.lines.length; y++) {
      const line = term.buffer.active.getLine(y)
      data.push({
        wrapped: line.isWrapped,
        cells: Array.from({ length: term.cols }, (_, x) => {
          const cell = line.getCell(x)
          return [
            cell.getChars(),
            cell.getWidth(),
            cell.getFgColorMode(),
            cell.getFgColor(),
            cell.getBgColorMode(),
            cell.getBgColor(),
            cell.isBold()
          ]
        })
      })
    }
    return {
      data,
      state: {
        x: buffer.x,
        y: buffer.y,
        ybase: buffer.ybase,
        ydisp: buffer.ydisp,
        savedX: buffer.savedX,
        savedY: buffer.savedY
      },
      markers: markers.map((marker) => ({ line: marker.line, disposed: marker.isDisposed })),
      invalidWrites,
      negativeSlots: Object.keys(buffer.lines._array).filter((key) => Number(key) < 0).length
    }
  }
  term.resize(scenario.newCols ?? 8, rows)
  const after = snapshot()
  const resizeEvents = events.splice(0)
  if (large) {
    term.options.scrollback = capacity - rows
  }
  // Exercise subsequent recycle, wider reflow, and another shrink without changing the options cap.
  term._core.writeSync('\r\nfollowup\r\n'.repeat(3))
  term.resize(100, rows)
  term.resize(8, rows)
  const followup = snapshot()
  for (const listener of listeners) {
    listener.dispose()
  }
  term.dispose()
  return { originalLength, originalStart, after, resizeEvents, followup }
}
function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}
const results = []
for (const packageName of ['@xterm/headless', '@xterm/xterm']) {
  installCandidate(packageName, false)
  const Original = require(packageName).Terminal
  const transform = installCandidate(packageName)
  const Candidate = require(packageName).Terminal
  for (const scenario of scenarios) {
    const before = run(Original, scenario)
    const after = run(Candidate, scenario)
    assert.equal(after.after.negativeSlots, 0, scenario.name)
    assert.equal(after.after.invalidWrites, 0, scenario.name)
    assert.equal(after.followup.invalidWrites, 0, scenario.name)
    assert.equal(after.followup.negativeSlots, 0, scenario.name)
    assert.deepEqual(
      after.after.state,
      before.after.state,
      `${scenario.name}: cursor/viewport state`
    )
    assert.deepEqual(after.after.markers, before.after.markers, `${scenario.name}: marker state`)
    assert.deepEqual(
      after.resizeEvents,
      before.resizeEvents,
      `${scenario.name}: insert/trim events`
    )
    const lineDifferences = before.after.data.flatMap((line, index) =>
      equal(line, after.after.data[index]) ? [] : [index]
    )
    let oracle
    if (scenario.oracle) {
      // Large capacity keeps the same reflow output without the faulty clipped insertion boundary.
      const reference = run(Original, scenario, true)
      const expected = reference.after.data.slice(-capacity)
      // Ignore the first line's wrapped bit: it can lose its predecessor when the old buffer trimmed.
      const actualCells = after.after.data.map((line) => line.cells)
      const expectedCells = expected.map((line) => line.cells)
      assert.deepEqual(actualCells, expectedCells, `${scenario.name}: retained cell oracle`)
      assert.deepEqual(
        after.after.data.slice(1).map((line) => line.wrapped),
        expected.slice(1).map((line) => line.wrapped),
        `${scenario.name}: wrapped oracle`
      )
      oracle = {
        referenceLength: reference.after.data.length,
        expectedLength: expected.length,
        passed: true
      }
    }
    if (before.after.invalidWrites === 0) {
      assert.deepEqual(
        after.after.data,
        before.after.data,
        `${scenario.name}: unchanged initial cells`
      )
    }
    if (before.followup.invalidWrites === 0) {
      assert.deepEqual(after.followup, before.followup, `${scenario.name}: unchanged followup`)
    }
    results.push({
      packageName,
      scenario: scenario.name,
      originalStart: before.originalStart,
      finalRows: after.after.data.length,
      baselineInvalidWrites: before.after.invalidWrites,
      baselineNegativeSlots: before.after.negativeSlots,
      candidateNegativeSlots: after.after.negativeSlots,
      lineDifferences,
      cursorParity: true,
      markerParity: true,
      eventParity: true,
      oracle,
      transform
    })
    console.log(
      JSON.stringify({
        packageName,
        scenario: scenario.name,
        baselineInvalidWrites: before.after.invalidWrites,
        lineDifferences: lineDifferences.length,
        oracle: !!oracle
      })
    )
  }
}
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex')
fs.writeFileSync(
  `${__dirname}/parity-results.json`,
  `${JSON.stringify({ sourceHashes: Object.fromEntries(['parity.cjs', 'install-candidate.cjs'].map((file) => [file, sha(fs.readFileSync(`${__dirname}/${file}`))])), cases: results }, null, 2)}\n`
)
