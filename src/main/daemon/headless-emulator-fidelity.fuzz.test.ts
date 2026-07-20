import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import {
  buildAgentTuiStreamOps,
  mulberry32,
  splitIntoRandomChunks,
  type AgentTuiStreamDims
} from '../../shared/agent-tui-ansi-fuzz-stream'
import {
  POST_REPLAY_LIVE_SNAPSHOT_RESET_PARITY,
  SNAPSHOT_REPLAY_PREAMBLE_ALT,
  SNAPSHOT_REPLAY_PREAMBLE_NORMAL,
  bufferHasSerializeHostileWrappedRow,
  createRendererParityTerminal,
  cursorPosition,
  normalBufferRowsTrimmed,
  visibleRowStyles,
  visibleRows,
  writeChunksToTerminal
} from '../../shared/terminal-restore-parity-fixture'

// Differential garble gate for the hidden-terminal contract: a hidden pane gets nothing, so main's
// HeadlessEmulator is source of truth and reveal repaints from the snapshot. This fuzz asserts the
// serialize→replay round trip matches an always-visible renderer twin — any diff = a garble bug on reveal.
//
// Runtime knobs:
//   FUZZ_ITERATIONS=5000  deep/nightly mode (default 300, keeps combined suite runtime <60s)
//   FUZZ_SEED=1234        re-run exactly one seed (repro from a failure log)

const DEFAULT_ITERATIONS = 300
const FIXED_SEED = readPositiveIntEnv('FUZZ_SEED')
const ITERATIONS =
  FIXED_SEED !== null ? 1 : (readPositiveIntEnv('FUZZ_ITERATIONS') ?? DEFAULT_ITERATIONS)
// Matches HIDDEN_OUTPUT_RESTORE_SCROLLBACK_ROWS in pty-connection.ts — the reveal restore's scrollback budget.
const HIDDEN_OUTPUT_RESTORE_SCROLLBACK_ROWS = 5000

function readPositiveIntEnv(name: string): number | null {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null
}

const DIMS: readonly AgentTuiStreamDims[] = [
  { cols: 80, rows: 24 },
  { cols: 100, rows: 30 },
  { cols: 120, rows: 40 }
]

type FidelityCase = {
  seed: number
  dims: AgentTuiStreamDims
  ops: string[]
  chunked: boolean
}

type FidelityDiff = {
  stage: string
  expected: unknown
  actual: unknown
  /** True when the buffer trips the known upstream addon-serialize blank-leading-wrapped-row bug (see bufferHasSerializeHostileWrappedRow). */
  knownSerializeWrapBug?: boolean
}

function buildCase(seed: number): FidelityCase {
  const rng = mulberry32(seed)
  const dims = DIMS[Math.floor(rng() * DIMS.length)]!
  const opCount = 12 + Math.floor(rng() * 28)
  const ops = buildAgentTuiStreamOps(rng, dims, {
    includeMouseModes: true,
    includeOscHyperlinks: false,
    opCount
  })
  return { seed, dims, ops, chunked: true }
}

function firstDiff(stage: string, expected: unknown, actual: unknown): FidelityDiff | null {
  return JSON.stringify(expected) === JSON.stringify(actual) ? null : { stage, expected, actual }
}

async function runFidelityCase(testCase: FidelityCase): Promise<FidelityDiff | null> {
  const stream = testCase.ops.join('')
  const chunks = testCase.chunked
    ? splitIntoRandomChunks(mulberry32(testCase.seed ^ 0x9e3779b9), stream, {
        minLen: 3,
        maxLen: 120
      })
    : [stream]
  const emulator = new HeadlessEmulator({ cols: testCase.dims.cols, rows: testCase.dims.rows })
  const control = createRendererParityTerminal(testCase.dims)
  const restored = createRendererParityTerminal(testCase.dims)
  try {
    for (const chunk of chunks) {
      await emulator.write(chunk)
    }
    await writeChunksToTerminal(control.terminal, chunks)

    // Stage 1 — model fidelity: the emulator's screen must match the renderer twin before any serialization.
    const modelDiff = firstDiff(
      'model-visible (HeadlessEmulator vs renderer twin)',
      visibleRows(control.terminal),
      emulator.getVisibleLines()
    )
    if (modelDiff) {
      return modelDiff
    }

    // Stage 2 — reveal round trip: serialize like serializeHiddenOutputRecoveryBuffer, replay like applyMainBufferSnapshot, compare to the always-visible twin.
    const alt = emulator.isAlternateScreen
    const snapshot = emulator.getSnapshot({
      scrollbackRows: alt ? 0 : HIDDEN_OUTPUT_RESTORE_SCROLLBACK_ROWS
    })
    await writeChunksToTerminal(restored.terminal, [
      alt ? SNAPSHOT_REPLAY_PREAMBLE_ALT : SNAPSHOT_REPLAY_PREAMBLE_NORMAL,
      snapshot.rehydrateSequences + snapshot.snapshotAnsi,
      POST_REPLAY_LIVE_SNAPSHOT_RESET_PARITY
    ])

    const diffs = [
      firstDiff(
        'restore-visible-text',
        visibleRows(control.terminal),
        visibleRows(restored.terminal)
      ),
      firstDiff(
        'restore-visible-styles',
        visibleRowStyles(control.terminal),
        visibleRowStyles(restored.terminal)
      ),
      firstDiff(
        'restore-cursor',
        cursorPosition(control.terminal),
        cursorPosition(restored.terminal)
      ),
      firstDiff(
        'restore-mode-bracketed-paste',
        control.terminal.modes.bracketedPasteMode,
        restored.terminal.modes.bracketedPasteMode
      ),
      // alt excludes both comparisons below by design: alt forces scrollbackRows=0 (no normal-buffer history) and reports applicationCursor=false (rehydrate omits ?1h).
      alt
        ? null
        : firstDiff(
            'restore-scrollback-text',
            normalBufferRowsTrimmed(control.terminal),
            normalBufferRowsTrimmed(restored.terminal)
          ),
      alt
        ? null
        : firstDiff(
            'restore-mode-application-cursor',
            control.terminal.modes.applicationCursorKeysMode,
            restored.terminal.modes.applicationCursorKeysMode
          )
    ]
    const diff = diffs.find((candidate) => candidate !== null) ?? null
    if (!diff) {
      return null
    }
    if (bufferHasSerializeHostileWrappedRow(control.terminal)) {
      return { ...diff, knownSerializeWrapBug: true }
    }
    return diff
  } finally {
    emulator.dispose()
    control.terminal.dispose()
    restored.terminal.dispose()
  }
}

/** Greedy op-drop minimizer: shrinks a failing case to the smallest still-diverging op list (with its seed for FUZZ_SEED replay). */
async function minimizeFailure(testCase: FidelityCase): Promise<FidelityCase> {
  let current = { ...testCase, chunked: false }
  if ((await runFidelityCase(current)) === null) {
    current = { ...testCase, chunked: true }
  }
  let budget = 400
  let shrunk = true
  while (shrunk && budget > 0) {
    shrunk = false
    for (let i = current.ops.length - 1; i >= 0 && budget > 0; i--) {
      const candidate = { ...current, ops: current.ops.toSpliced(i, 1) }
      budget -= 1
      if ((await runFidelityCase(candidate)) !== null) {
        current = candidate
        shrunk = true
      }
    }
  }
  return current
}

function formatFailure(minimized: FidelityCase, diff: FidelityDiff | null): string {
  return [
    `HeadlessEmulator fidelity divergence — stage: ${diff?.stage ?? 'unknown'}`,
    `seed: ${minimized.seed} (re-run: FUZZ_SEED=${minimized.seed} pnpm exec vitest run --config config/vitest.config.ts src/main/daemon/headless-emulator-fidelity.fuzz.test.ts)`,
    `dims: ${minimized.dims.cols}x${minimized.dims.rows} chunked: ${minimized.chunked}`,
    `minimized ops (${minimized.ops.length}): ${JSON.stringify(minimized.ops)}`,
    `expected (always-visible renderer twin): ${JSON.stringify(diff?.expected)}`,
    `actual   (snapshot restore replay):      ${JSON.stringify(diff?.actual)}`
  ].join('\n')
}

describe('headless emulator snapshot fidelity fuzz', () => {
  // Known-legitimate divergence: SerializeAddon never re-emits OSC 8, so byte-replay drops the link underline; production carries the ranges out-of-band in snapshot.oscLinks.
  it('drops OSC 8 underline from byte replay but preserves the range in snapshot metadata', async () => {
    const emulator = new HeadlessEmulator({ cols: 60, rows: 10 })
    const restored = createRendererParityTerminal({ cols: 60, rows: 10 })
    try {
      await emulator.write('\x1b]8;;https://example.com/pr/7\x07review link\x1b]8;;\x07 tail')
      const snapshot = emulator.getSnapshot({ scrollbackRows: 5000 })
      await writeChunksToTerminal(restored.terminal, [
        SNAPSHOT_REPLAY_PREAMBLE_NORMAL,
        snapshot.rehydrateSequences + snapshot.snapshotAnsi,
        POST_REPLAY_LIVE_SNAPSHOT_RESET_PARITY
      ])
      expect(visibleRows(restored.terminal)[0]).toBe('review link tail')
      expect(snapshot.oscLinks).toContainEqual({
        row: 0,
        startCol: 0,
        endCol: 11,
        uri: 'https://example.com/pr/7'
      })
    } finally {
      emulator.dispose()
      restored.terminal.dispose()
    }
  })

  it(`matches an always-visible renderer twin across ${ITERATIONS} seeded agent-TUI streams`, async () => {
    // Bug A (serialize wrap) is tolerated + counted so deep mode surfaces only new divergences; B and C are fixed, so their regressions fail loudly.
    let knownSerializeWrapBugHits = 0
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = FIXED_SEED ?? 1 + i
      const testCase = buildCase(seed)
      const diff = await runFidelityCase(testCase)
      if (diff?.knownSerializeWrapBug) {
        knownSerializeWrapBugHits += 1
        continue
      }
      if (diff) {
        const minimized = await minimizeFailure(testCase)
        const minimizedDiff = await runFidelityCase(minimized)
        expect.fail(formatFailure(minimized, minimizedDiff ?? diff))
      }
    }
    // Guard the tolerance: the predicate tripping on most seeds means the gate has gone degenerate.
    expect(knownSerializeWrapBugHits).toBeLessThan(Math.max(3, ITERATIONS * 0.5))
  }, 600_000)

  // HEADLINE FINDING (do not delete while unfixed upstream): @xterm/addon-serialize 0.15.0-beta.287
  // doesn't round-trip null cells at a soft-wrap boundary, garbling every snapshot restore of a TUI that
  // erased inside a soft-wrapped line. Repros below — V1 cell loss (seed 31, SerializeAddon.ts ~L214
  // wrap-validity ternary), V2 stray '-' filler (seed 157). Unskip once the upstream fix lands.
  it.skip('round-trips a wrapped line whose continuation row starts with an erased cell', async () => {
    const emulator = new HeadlessEmulator({ cols: 20, rows: 6 })
    const control = createRendererParityTerminal({ cols: 20, rows: 6 })
    const restored = createRendererParityTerminal({ cols: 20, rows: 6 })
    try {
      const bytes = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ12\r\n', '\x1b[1A\x1b[1K']
      for (const chunk of bytes) {
        await emulator.write(chunk)
      }
      await writeChunksToTerminal(control.terminal, bytes)
      const snapshot = emulator.getSnapshot({ scrollbackRows: 5000 })
      await writeChunksToTerminal(restored.terminal, [
        SNAPSHOT_REPLAY_PREAMBLE_NORMAL,
        snapshot.rehydrateSequences + snapshot.snapshotAnsi,
        POST_REPLAY_LIVE_SNAPSHOT_RESET_PARITY
      ])
      expect(visibleRows(restored.terminal)).toEqual(visibleRows(control.terminal))
    } finally {
      emulator.dispose()
      control.terminal.dispose()
      restored.terminal.dispose()
    }
  })

  // V2 repro of the headline finding (stray '-' on a fully erased wrapped source row); unskip with V1.
  it.skip('round-trips a wrapped line whose source row was fully erased', async () => {
    const emulator = new HeadlessEmulator({ cols: 20, rows: 6 })
    const control = createRendererParityTerminal({ cols: 20, rows: 6 })
    const restored = createRendererParityTerminal({ cols: 20, rows: 6 })
    try {
      // Wrap a 28-char line, then erase its entire first (source) row: cursor up twice, EL 2.
      const bytes = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ12\r\n', '\x1b[2A\x1b[2K']
      for (const chunk of bytes) {
        await emulator.write(chunk)
      }
      await writeChunksToTerminal(control.terminal, bytes)
      const snapshot = emulator.getSnapshot({ scrollbackRows: 5000 })
      await writeChunksToTerminal(restored.terminal, [
        SNAPSHOT_REPLAY_PREAMBLE_NORMAL,
        snapshot.rehydrateSequences + snapshot.snapshotAnsi,
        POST_REPLAY_LIVE_SNAPSHOT_RESET_PARITY
      ])
      // Fails today: restored row 0 shows '-' where the live row is blank.
      expect(visibleRows(restored.terminal)).toEqual(visibleRows(control.terminal))
    } finally {
      emulator.dispose()
      control.terminal.dispose()
      restored.terminal.dispose()
    }
  })

  // Bug B guard: upstream emitted 1;22m and SGR 22 clears both bold and dim, dropping bold; fixed by the intensity-group reorder in the addon-serialize patch. notes/garble-fuzz-divergences.md
  it('preserves bold when serializing a dim cell followed by a bold-only cell', async () => {
    const emulator = new HeadlessEmulator({ cols: 20, rows: 4 })
    const control = createRendererParityTerminal({ cols: 20, rows: 4 })
    const restored = createRendererParityTerminal({ cols: 20, rows: 4 })
    try {
      // 'A' dim, 'B' bold-only; patched serializer emits 22;1 for B (clear before re-set).
      const bytes = ['\x1b[2mA\x1b[22m\x1b[1mB\x1b[0m']
      for (const chunk of bytes) {
        await emulator.write(chunk)
      }
      await writeChunksToTerminal(control.terminal, bytes)
      const snapshot = emulator.getSnapshot({ scrollbackRows: 5000 })
      await writeChunksToTerminal(restored.terminal, [
        SNAPSHOT_REPLAY_PREAMBLE_NORMAL,
        snapshot.rehydrateSequences + snapshot.snapshotAnsi,
        POST_REPLAY_LIVE_SNAPSHOT_RESET_PARITY
      ])
      expect(visibleRowStyles(restored.terminal)).toEqual(visibleRowStyles(control.terminal))
    } finally {
      emulator.dispose()
      control.terminal.dispose()
      restored.terminal.dispose()
    }
  })

  // Bug C guard: upstream serialize lands the cursor one col short (wrap-pending); fixed by absolute-CUP epilogue (serializeWithAbsoluteCursor). notes/garble-fuzz-divergences.md
  it('restores the cursor exactly when the last content row fills the right margin', async () => {
    const emulator = new HeadlessEmulator({ cols: 10, rows: 4 })
    const control = createRendererParityTerminal({ cols: 10, rows: 4 })
    const restored = createRendererParityTerminal({ cols: 10, rows: 4 })
    try {
      // Fill row 0 to the margin (wrap-pending), then CUP to a lower row; live cursor is (x=4, y=2).
      const bytes = ['0123456789\x1b[3;5H']
      for (const chunk of bytes) {
        await emulator.write(chunk)
      }
      await writeChunksToTerminal(control.terminal, bytes)
      const snapshot = emulator.getSnapshot({ scrollbackRows: 5000 })
      await writeChunksToTerminal(restored.terminal, [
        SNAPSHOT_REPLAY_PREAMBLE_NORMAL,
        snapshot.rehydrateSequences + snapshot.snapshotAnsi,
        POST_REPLAY_LIVE_SNAPSHOT_RESET_PARITY
      ])
      expect(cursorPosition(restored.terminal)).toEqual(cursorPosition(control.terminal))
    } finally {
      emulator.dispose()
      control.terminal.dispose()
      restored.terminal.dispose()
    }
  })
})
