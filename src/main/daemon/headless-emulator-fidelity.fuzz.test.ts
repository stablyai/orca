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

// Differential garble gate for the hidden-terminal model/view contract:
// with the hidden-delivery
// gate on, a hidden pane receives NOTHING — main's HeadlessEmulator is the
// source of truth and reveal repaints the renderer xterm from
// preamble + rehydrateSequences + snapshotAnsi (applyMainBufferSnapshot).
// This fuzz feeds seeded agent-TUI byte streams to the production emulator
// and to an always-visible renderer-parity terminal, then asserts the
// serialize→replay round trip reproduces the exact screen the renderer would
// have shown. Any diff = a garble bug on reveal.
//
// Runtime knobs:
//   FUZZ_ITERATIONS=5000  deep/nightly mode (default 300, <60s combined with
//                         the reveal-reconciliation suite)
//   FUZZ_SEED=1234        re-run exactly one seed (repro from a failure log)

const DEFAULT_ITERATIONS = 300
const FIXED_SEED = readPositiveIntEnv('FUZZ_SEED')
const ITERATIONS =
  FIXED_SEED !== null ? 1 : (readPositiveIntEnv('FUZZ_ITERATIONS') ?? DEFAULT_ITERATIONS)
// Matches HIDDEN_OUTPUT_RESTORE_SCROLLBACK_ROWS in pty-connection.ts — the
// scrollback budget the reveal restore actually requests from main.
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
  /** True when the always-visible buffer matches the known upstream
   *  @xterm/addon-serialize blank-leading-wrapped-row bug predicate — see
   *  bufferHasSerializeHostileWrappedRow and the skipped repro test below. */
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

    // Stage 1 — model fidelity: the emulator's screen must already match the
    // renderer twin before any serialization enters the picture.
    const modelDiff = firstDiff(
      'model-visible (HeadlessEmulator vs renderer twin)',
      visibleRows(control.terminal),
      emulator.getVisibleLines()
    )
    if (modelDiff) {
      return modelDiff
    }

    // Stage 2 — reveal round trip: serialize exactly like
    // serializeHiddenOutputRecoveryBuffer, replay exactly like
    // applyMainBufferSnapshot, then compare against the always-visible twin.
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
      // Why alt is excluded from the two comparisons below:
      // - scrollback: serializeHeadlessTerminalBuffer (orca-runtime.ts)
      //   deliberately forces scrollbackRows=0 while an alt-screen TUI is
      //   active, so normal-buffer history is not part of the alt contract.
      // - application cursor: HeadlessEmulator.getModes reports
      //   applicationCursor false on the alternate buffer, so rehydrate omits
      //   ?1h there by design.
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

/** Greedy op-drop minimizer: re-runs the full differential pipeline on
 *  smaller op lists so a failure report carries the smallest byte stream that
 *  still diverges (plus its seed for exact replay via FUZZ_SEED). */
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
  // Known-legitimate divergence, pinned so it cannot silently regress into a
  // real one: xterm marks OSC 8 hyperlink cells underlined, SerializeAddon
  // never re-emits OSC 8, and production compensates by shipping the ranges
  // out-of-band in snapshot.oscLinks (collectHeadlessOscLinkRanges) for the
  // renderer link provider to re-register. Byte-replay therefore keeps the
  // TEXT but not the link underline — the metadata must carry the range.
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
    // The known-and-pinned serialize wrap bug (A) is tolerated + counted so
    // deep mode (FUZZ_ITERATIONS) surfaces only GENUINELY NEW divergences.
    // Bugs B (bold-reset, fixed by the addon patch) and C (margin cursor,
    // fixed by the absolute-cursor epilogue) are no longer tolerated — a
    // regression fails the corpus loudly and the unskipped repros below.
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
    // Guard the tolerance from swallowing the suite: the predicate tripping
    // on most seeds means the gate has gone degenerate.
    expect(knownSerializeWrapBugHits).toBeLessThan(Math.max(3, ITERATIONS * 0.5))
  }, 600_000)

  // ── HEADLINE FINDING (do not delete while unfixed upstream) ──────────────
  // @xterm/addon-serialize 0.15.0-beta.287 does not round-trip null cells
  // that touch a soft-wrap boundary. Two variants, both found by this fuzz
  // and minimized below. Every Orca snapshot consumer is affected: hidden
  // reveal, parked-tab reveal, sleep/wake restore, and mobile subscribe
  // replay paint lost/shifted characters or stray '-' fillers whenever a TUI
  // erased inside a soft-wrapped line (shell line editing, status lines wider
  // than the pane, Claude Code in-place prompt redraws).
  //
  // V1 — cell loss (found by seed 31, minimized to 2 ops):
  // Root cause: the wrap-validity ternary in SerializeAddon.ts (~L214)
  //   nextRowFirstChar.getChars() && isNextRowFirstCharDoubleWidth
  //     ? this._nullCellCount <= 1 : this._nullCellCount <= 0
  // binds as `(chars && doubleWidth) ? ...`, so a null-leading wrapped row
  // passes as a "natural" wrap. The serializer then emits the previous row as
  // full-width text (leaving xterm in wrap-pending) and skips the null cell
  // with CUF (`ESC[1C`) — but CUF clamps at the right margin instead of
  // crossing the wrap boundary, so the next character overwrites the previous
  // row's last cell and the whole tail shifts left by one.
  //   cols=20: write 'ABCDEFGHIJKLMNOPQRSTUVWXYZ12\r\n' then '\x1b[1A\x1b[1K'
  //   live rows:     ['ABCDEFGHIJKLMNOPQRST', ' VWXYZ12']
  //   serialize():   'ABCDEFGHIJKLMNOPQRST\x1b[1CVWXYZ12\x1b[8D'
  //   replayed rows: ['ABCDEFGHIJKLMNOPQRSV', 'WXYZ12']   ← 'T' eaten, tail shifted
  //
  // V2 — stray filler '-' (found by seed 157, minimized below): when the
  // SOURCE row of a wrapped pair is entirely null (a TUI erased the whole
  // first half of a wrapped line), the addon's forced-wrap "magic" writes
  // nullCellCount+1 dashes and then cleans up with
  //   ESC[A ESC[(length-nullCellCount)C ESC[(nullCellCount)X ...
  // With length === nullCellCount that cursor-forward becomes `ESC[0C`, and
  // CSI param 0 means 1, so the ECH erase lands one cell right and the first
  // '-' stays visible on the restored row.
  // Unskip once the upstream fix (or a local serialize post-processor) lands.
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

  // V2 repro of the headline finding above (stray '-' filler on a fully
  // erased wrapped source row). Unskip alongside the V1 repro.
  it.skip('round-trips a wrapped line whose source row was fully erased', async () => {
    const emulator = new HeadlessEmulator({ cols: 20, rows: 6 })
    const control = createRendererParityTerminal({ cols: 20, rows: 6 })
    const restored = createRendererParityTerminal({ cols: 20, rows: 6 })
    try {
      // Wrap a 28-char line, then erase the entire first (source) row of the
      // wrapped pair: cursor up twice onto it, EL 2.
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

  // ── Bug B regression guard: SGR bold on a dim→bold-only cell transition ──
  // Upstream @xterm/addon-serialize emitted `\x1b[1;22m` for this transition;
  // SGR 22 (normalIntensity) clears BOTH bold and dim, so the restored cell
  // lost its bold. FIXED by the intensity-group reorder in
  // config/patches/@xterm__addon-serialize@0.15.0-beta.287.patch (22 before
  // 1/2). Found by fuzz seeds 435, 770, 1321; mechanism in
  // notes/garble-fuzz-divergences.md (Bug B).
  it('preserves bold when serializing a dim cell followed by a bold-only cell', async () => {
    const emulator = new HeadlessEmulator({ cols: 20, rows: 4 })
    const control = createRendererParityTerminal({ cols: 20, rows: 4 })
    const restored = createRendererParityTerminal({ cols: 20, rows: 4 })
    try {
      // 'A' dim, 'B' bold-only. Live: A=dim, B=bold. The patched serializer
      // emits 22;1 for the B transition (clear before re-set).
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

  // ── Bug C regression guard: cursor exact when the last row fills the margin ──
  // Upstream @xterm/addon-serialize computes its relative cursor-restore from
  // a wrap-pending position and lands one column short. FIXED Orca-side: the
  // emulator snapshot appends an absolute CUP from the source's authoritative
  // cursor (serializeWithAbsoluteCursor). Found by fuzz seeds 454, 1696;
  // mechanism in notes/garble-fuzz-divergences.md (Bug C).
  it('restores the cursor exactly when the last content row fills the right margin', async () => {
    const emulator = new HeadlessEmulator({ cols: 10, rows: 4 })
    const control = createRendererParityTerminal({ cols: 10, rows: 4 })
    const restored = createRendererParityTerminal({ cols: 10, rows: 4 })
    try {
      // Fill row 0 to exactly 10 cols (wrap-pending), then CUP the cursor to a
      // known lower-row column. Live cursor is (x=4, y=2).
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
