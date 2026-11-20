import type {
  GapRecovery,
  RuntimeHeadlessTerminal
} from '../records/runtime-terminal-state-records'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import { projectTerminalVisibleLines } from '../view/orca-runtime-terminal-projection'
import type { RuntimeTerminalProjection } from './terminal-projection'

export type KeptGapScreen = RuntimeTerminalProjection & { seq: number; capturedAt: number }

/** Keeps a frame known correct at `seq` unless a newer one is kept; it is read lazily, once. */
export function keepGapRecoveryScreen(
  recovery: GapRecovery,
  seq: number,
  capturedAt: number,
  read: () => RuntimeTerminalProjection | Promise<RuntimeTerminalProjection>
): void {
  if (recovery.keptScreen && recovery.keptScreen.seq >= seq) {
    return
  }
  let projection: Promise<RuntimeTerminalProjection> | undefined
  recovery.keptScreen = {
    seq,
    capturedAt,
    read: () =>
      (projection ??= Promise.resolve()
        .then(read)
        .catch(() => ({ lines: [] })))
  }
}

/** A half-drawn frame is not a correct screen. */
export function keepLandedGapScreen(
  recovery: GapRecovery | undefined,
  snapshot: PtyProviderBufferSnapshot,
  capturedAt: number,
  parse: (frame: { data: string; cols: number; rows: number }) => Promise<RuntimeTerminalProjection>
): void {
  if (recovery && !snapshot.synchronizedOutput) {
    const { data, cols, rows } = snapshot
    keepGapRecoveryScreen(recovery, snapshot.seq, capturedAt, () => parse({ data, cols, rows }))
  }
}

/** Runs in stream order at the first gap: the trusted model's screen through the last byte before the drop, unless half-drawn. */
export function keepPreGapScreen(state: RuntimeHeadlessTerminal, trusted: boolean): void {
  if (trusted && state.gapReseed && !state.emulator.isSynchronizedOutput) {
    const frame = projectTerminalVisibleLines(state.emulator)
    keepGapRecoveryScreen(state.gapReseed, state.outputSequence, Date.now(), () => frame)
  }
}

/** The newest correct frame a rebuilding screen has, or null when it never had one. */
export async function readKeptGapScreen(
  recovery: GapRecovery | undefined
): Promise<KeptGapScreen | null> {
  const kept = recovery?.keptScreen
  if (!kept) {
    return null
  }
  const projection = await kept.read()
  return projection.lines.length > 0
    ? { ...projection, seq: kept.seq, capturedAt: kept.capturedAt }
    : null
}
