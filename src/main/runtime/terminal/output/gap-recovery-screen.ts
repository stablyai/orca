import type {
  GapRecovery,
  GapScreenIdentity,
  RuntimeHeadlessTerminal
} from '../records/runtime-terminal-state-records'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import { projectTerminalVisibleLines } from '../../../daemon/emulation/terminal-screen-projection'
import type { RuntimeTerminalProjection } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'

export type KeptGapScreen = RuntimeTerminalProjection & { seq: number; capturedAt: number }

// A null anchor is a seq in runtime coordinates, which no re-anchor moves.
function sameStream(a: GapScreenIdentity, b: GapScreenIdentity): boolean {
  return (
    a.generation === b.generation &&
    (a.anchorRevision === null ||
      b.anchorRevision === null ||
      a.anchorRevision === b.anchorRevision)
  )
}

/** Keeps a frame known correct at `seq` unless a newer one of the same stream is kept. It is projected on first
 *  read, or when its capture attempt ends without rebuilding, so a landed capture's ANSI (the whole live window)
 *  is never parsed for a rebuild that succeeds, nor held past the attempt that captured it. */
export function keepGapRecoveryScreen(
  recovery: GapRecovery,
  frame: GapScreenIdentity & { seq: number; capturedAt: number },
  read: () => RuntimeTerminalProjection | Promise<RuntimeTerminalProjection>
): void {
  const kept = recovery.keptScreen
  if (kept && sameStream(kept, frame) && kept.seq >= frame.seq) {
    return
  }
  // Dropped once its parse starts, so the captured ANSI it closes over is not held beside the projection.
  let parse: typeof read | undefined = read
  let projection: Promise<RuntimeTerminalProjection | null> | undefined
  recovery.keptScreen = {
    generation: frame.generation,
    anchorRevision: frame.anchorRevision,
    seq: frame.seq,
    capturedAt: frame.capturedAt,
    read: () => {
      if (!projection) {
        const run = parse
        parse = undefined
        projection = Promise.resolve()
          .then(() => run?.() ?? null)
          .catch(() => null)
      }
      return projection
    }
  }
}

/** A half-drawn frame is not a correct screen. */
export function keepLandedGapScreen(
  recovery: GapRecovery | undefined,
  snapshot: PtyProviderBufferSnapshot,
  stream: GapScreenIdentity & { capturedAt: number },
  parse: (frame: { data: string; cols: number; rows: number }) => Promise<RuntimeTerminalProjection>
): void {
  if (recovery && !snapshot.synchronizedOutput) {
    const { data, cols, rows } = snapshot
    keepGapRecoveryScreen(recovery, { ...stream, seq: snapshot.seq }, () =>
      parse({ data, cols, rows })
    )
  }
}

/** Runs in stream order at the first gap: the trusted model's screen through the last byte before the drop, unless half-drawn. */
export function keepPreGapScreen(
  state: RuntimeHeadlessTerminal,
  stream: GapScreenIdentity | null
): void {
  if (stream && state.gapReseed && !state.emulator.isSynchronizedOutput) {
    const frame = projectTerminalVisibleLines(state.emulator)
    keepGapRecoveryScreen(
      state.gapReseed,
      { ...stream, anchorRevision: null, seq: state.outputSequence, capturedAt: Date.now() },
      () => frame
    )
  }
}

/** A capture attempt that did not rebuild, on a terminal still recovering, parses its frame now and releases
 *  the ANSI it captured; a retired terminal's frame is never parsed. */
export function settleKeptGapScreen(recovery: GapRecovery, stillRecovering: boolean): void {
  if (stillRecovering) {
    void recovery.keptScreen?.read()
  }
}

/** The newest correct frame a rebuilding screen has, blank included, or null when it has none of the live stream. */
export async function readKeptGapScreen(
  recovery: GapRecovery | undefined,
  liveStream: () => GapScreenIdentity
): Promise<KeptGapScreen | null> {
  const kept = recovery?.keptScreen
  if (!kept || !sameStream(kept, liveStream())) {
    return null
  }
  const projection = await kept.read()
  // A reset or re-anchor while parsing leaves the frame's seq incomparable with the live stream.
  return projection && sameStream(kept, liveStream())
    ? { ...projection, seq: kept.seq, capturedAt: kept.capturedAt }
    : null
}
