#!/usr/bin/env bun

if (!globalThis.Bun?.Terminal) {
  throw new Error('Run this proof with Bun 1.3.14 or newer')
}

const INPUT_MARKER = 'ORCAD_BUN_PTY_INPUT'
const RESIZED_COLS = 97
const RESIZED_ROWS = 31
const decoder = new TextDecoder()
let output = ''
let inputSent = false

const childSource = String.raw`
process.stdout.write(JSON.stringify({
  kind: 'ready',
  isTTY: process.stdout.isTTY === true,
  columns: process.stdout.columns,
  rows: process.stdout.rows
}) + '\n')
process.stdin.setEncoding('utf8')
process.stdin.once('data', (data) => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      kind: 'ack',
      input: data.trim(),
      columns: process.stdout.columns,
      rows: process.stdout.rows
    }) + '\n')
    process.exit(0)
  }, 25)
})
`

const proc = Bun.spawn([process.execPath, '-e', childSource], {
  timeout: 5_000,
  terminal: {
    cols: 80,
    rows: 24,
    data(terminal, bytes) {
      output += decoder.decode(bytes, { stream: true })
      if (!inputSent && output.includes('"kind":"ready"')) {
        inputSent = true
        terminal.resize(RESIZED_COLS, RESIZED_ROWS)
        terminal.write(`${INPUT_MARKER}\n`)
      }
    }
  }
})

const exitCode = await proc.exited
await Bun.sleep(25)
output += decoder.decode()
proc.terminal?.close()

const records = [...output.matchAll(/\{[^\r\n]+\}/g)]
  .map(([record]) => {
    try {
      return JSON.parse(record)
    } catch {
      return null
    }
  })
  .filter(Boolean)
const ready = records.find((record) => record.kind === 'ready')
const ack = records.find((record) => record.kind === 'ack')

const failures = [
  exitCode === 0 || `child exit code was ${exitCode}`,
  ready?.isTTY === true || 'child stdout was not a TTY',
  ack?.input === INPUT_MARKER || 'terminal input did not round-trip',
  ack?.columns === RESIZED_COLS || `resized columns were ${String(ack?.columns)}`,
  ack?.rows === RESIZED_ROWS || `resized rows were ${String(ack?.rows)}`
].filter((result) => result !== true)

console.log(
  JSON.stringify({
    runtime: `bun ${Bun.version}`,
    platform: `${process.platform}-${process.arch}`,
    exitCode,
    ready,
    ack,
    unsupportedByBunTerminal: ['read-side pause/resume', 'Windows per-PTY job handles'],
    ok: failures.length === 0,
    failures
  })
)

if (failures.length > 0) {
  process.exit(1)
}
