import { writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { readPtyTail, runtimeWithLeaf } from './orca-runtime-pty-leaf.test-fixture'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { appendPerCharacterRedrawReference } from './terminal-tail-per-character-redraw.test-fixture'
import * as redrawBuffer from './terminal-tail-redraw-buffer'
import { buildRestoredTerminalTailSeed } from './terminal-tail-restore-seed'

// #11315 review probes, timed against the vendored pre-#11315 row model on all three main-thread
// entry points. ORCA_TAIL_WALL_TIME_FULL=1 runs them at restore-cap scale; ORCA_TAIL_WALL_TIME_TABLE
// names a file that receives the measured table.

const ESC = '\x1b'
const FULL = process.env.ORCA_TAIL_WALL_TIME_FULL === '1'
const WIDTH = FULL ? 128_000 : 8_000
const BUDGET = FULL ? 256 * 1024 - 16 : 32 * 1024
const FLOOD_CHUNKS = FULL ? 4 : 1
// The review probes used 1,500-4,000 revisits; more only lengthens the old model's run.
const MAX_REVISITS = 4_000
// Generous so a loaded CI host does not flake; the measured bar is 1.5x.
const MAX_RATIO = 3
const SLACK_MS = 30
const ROUNDS = Number(process.env.ORCA_TAIL_WALL_TIME_ROUNDS ?? 3)

type Probe = { name: string; chunks: string[] }

const letter = (index: number): string => String.fromCharCode(0x61 + (index % 26))

/** One wide row, then as many revisits as fit the byte budget. */
function revisits(name: string, row: string, unit: (index: number) => string): Probe {
  const count = Math.min(
    MAX_REVISITS,
    Math.max(1, Math.floor((BUDGET - row.length) / unit(0).length))
  )
  const parts = Array.from({ length: count }, (_, index) => unit(index))
  return { name, chunks: [`${ESC}[1A\r${row}\n${parts.join('')}`] }
}

/** 64 KiB live chunks against a persistent tail holding one wide row. */
function flood(name: string, width: number, unit: (index: number) => string): Probe {
  const perChunk = Math.floor((64 * 1024) / unit(0).length)
  const chunks = [`${'x'.repeat(width)}\n`]
  for (let chunk = 0; chunk < FLOOD_CHUNKS; chunk += 1) {
    chunks.push(Array.from({ length: perChunk }, (_, index) => unit(index + chunk)).join(''))
  }
  return { name, chunks }
}

function probes(): Probe[] {
  const x = 'x'.repeat(WIDTH)
  const half = Math.floor(WIDTH / 2)
  const rows = [`${'x'.repeat(half)}\n${'y'.repeat(half)}\n`]
  const twoRowCount = Math.floor((BUDGET - WIDTH) / 10)
  rows.push(
    Array.from({ length: twoRowCount }, (_, i) => `${ESC}[2A${letter(i)}\n${letter(i)}\n`).join('')
  )
  const panel = (label: string, width: number): string =>
    `\r${ESC}[2K${label} ${'─'.repeat(width - label.length - 1)}\n`
  const frame = `${ESC}[4A${['title', 'option a', 'option b', 'hint'].map((l) => panel(l, 200)).join('')}`
  return [
    revisits('cursor-only, trailing spaces', `panel${' '.repeat(WIDTH - 5)}`, () => `${ESC}[1A\n`),
    revisits('cursor-only, trailing tabs', `panel${'\t'.repeat(WIDTH - 5)}`, () => `${ESC}[1A\n`),
    revisits('33 identical edits per revisit', x, () => `${ESC}[1A${'\ry'.repeat(33)}\n`),
    revisits('alternating one-character edit', x, (i) => `${ESC}[1A\r${i % 2 ? 'a' : 'b'}\n`),
    revisits(
      'changing edit, trailing spaces',
      `p${' '.repeat(WIDTH - 1)}`,
      (i) => `${ESC}[A${letter(i)}\n`
    ),
    revisits(
      'changing edit, trailing tabs',
      `p${'\t'.repeat(WIDTH - 1)}`,
      (i) => `${ESC}[A${letter(i)}\n`
    ),
    revisits('ESC[4000G write', x, (i) => `${ESC}[A${ESC}[4000G${letter(i)}\n`),
    revisits('ESC[1K erase', x, (i) => `${ESC}[A\r${letter(i)}${ESC}[4000G${ESC}[1K\n`),
    revisits('ESC[K then write', x, (i) => `${ESC}[A${ESC}[2000G${ESC}[K${letter(i)}\n`),
    {
      name: 'ESC[1K erase, no newline',
      chunks: [
        `${x}${Array.from({ length: Math.floor((BUDGET - WIDTH) / 12) }, (_, i) => `\r${letter(i)}${ESC}[4000G${ESC}[1K`).join('')}`
      ]
    },
    {
      name: 'one row, no newline',
      chunks: [
        `${x}${Array.from({ length: Math.floor((BUDGET - WIDTH) / 2) }, (_, i) => `\r${letter(i)}`).join('')}`
      ]
    },
    { name: 'two alternating rows', chunks: [rows.join('')] },
    { name: 'write/backspace runs', chunks: [`${'x'.repeat(4_000)}\r${'ab\b'.repeat(2_000)}`] },
    {
      name: '#11315 panel repaint flood',
      chunks: [`${'\n'.repeat(4)}${frame.repeat(Math.floor(BUDGET / frame.length))}`]
    },
    ...[4_000, 16_000, 128_000].flatMap((width) => [
      flood(`live 64 KiB flood, ${width} cols`, width, (i) => `${ESC}[A${letter(i)}\n`),
      flood(
        `live 64 KiB ESC[1K flood, ${width} cols`,
        width,
        (i) => `${ESC}[A\r${letter(i)}${ESC}[4000G${ESC}[1K\n`
      )
    ])
  ]
}

type Entry = { name: string; run: (chunks: string[]) => { ms: number; result: unknown } }

function timed(run: () => unknown): { ms: number; result: unknown } {
  const started = performance.now()
  const result = run()
  return { ms: performance.now() - started, result }
}

const entries: Entry[] = [
  { name: 'restore', run: (chunks) => timed(() => buildRestoredTerminalTailSeed(chunks.join(''))) },
  {
    name: 'append',
    run: (chunks) =>
      timed(() => {
        let tail: Pick<
          ReturnType<typeof appendNormalizedToTailBuffer>,
          'lines' | 'partialLine' | 'redrawCursor'
        > = { lines: [], partialLine: '', redrawCursor: null }
        let pending = ''
        for (const chunk of chunks) {
          const normalized = normalizeTerminalChunk(chunk, pending)
          pending = normalized.pendingAnsi
          tail = appendNormalizedToTailBuffer(
            tail.lines,
            tail.partialLine,
            normalized.text,
            tail.redrawCursor
          )
        }
        return tail
      })
  },
  {
    name: 'onPtyData',
    run: (chunks) => {
      const ptyId = 'pty-wall-time'
      const { runtime } = runtimeWithLeaf(ptyId)
      const measured = timed(() => {
        chunks.forEach((chunk, index) => runtime.onPtyData(ptyId, chunk, index + 1))
        return readPtyTail(runtime, ptyId)
      })
      void runtime.onPtyExit(ptyId, 0)
      return measured
    }
  }
]

function withPerCharacterRows<T>(run: () => T): T {
  const reference = vi
    .spyOn(redrawBuffer, 'appendNormalizedToMultilineTailBufferUnwindowed')
    .mockImplementation(appendPerCharacterRedrawReference)
  try {
    return run()
  } finally {
    reference.mockRestore()
  }
}

describe('terminal tail redraw wall time against the per-character row model', () => {
  it(
    'is no slower than the old row model on any review probe',
    () => {
      const table: string[] = []
      const tablePath = process.env.ORCA_TAIL_WALL_TIME_TABLE
      const only = process.env.ORCA_TAIL_WALL_TIME_PROBE
      for (const probe of probes().filter((p) => !only || p.name.includes(only))) {
        for (const entry of entries) {
          let current = Number.POSITIVE_INFINITY
          let reference = Number.POSITIVE_INFINITY
          // Alternate the order so JIT warm-up and GC debt do not favor one model.
          for (let round = 0; round < ROUNDS; round += 1) {
            const runReference = (): ReturnType<Entry['run']> =>
              withPerCharacterRows(() => entry.run(probe.chunks))
            const before = round % 2 === 1 ? runReference() : null
            const now = entry.run(probe.chunks)
            const after = before ?? runReference()
            expect(now.result, `${probe.name} via ${entry.name}`).toEqual(after.result)
            current = Math.min(current, now.ms)
            reference = Math.min(reference, after.ms)
          }
          table.push(
            `| ${probe.name} | ${entry.name} | ${reference.toFixed(1)} | ${current.toFixed(1)} |`
          )
          if (tablePath) {
            writeFileSync(
              tablePath,
              ['| Probe | Entry | Old ms | Now ms |', '|---|---|---:|---:|', ...table].join('\n')
            )
          }
          expect(
            current,
            `${probe.name} via ${entry.name}: ${current} vs ${reference} ms`
          ).toBeLessThan(reference * MAX_RATIO + SLACK_MS)
        }
      }
    },
    FULL ? 1_800_000 : 180_000
  )
})
