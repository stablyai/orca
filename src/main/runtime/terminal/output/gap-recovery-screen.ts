import type {
  GapRecovery,
  GapScreenIdentity,
  RuntimeHeadlessTerminal
} from '../records/runtime-terminal-state-records'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import { projectTerminalVisibleLines } from '../view/orca-runtime-terminal-projection'
import type { RuntimeTerminalProjection } from './terminal-projection'

export type KeptGapScreen = RuntimeTerminalProjection & { seq: number; capturedAt: number }

function sameStream(a: GapScreenIdentity, b: GapScreenIdentity): boolean {
  return a.generation === b.generation && a.anchorRevision === b.anchorRevision
}

/** Keeps a frame known correct at `seq` unless a newer one of the same stream is kept. It is projected at once,
 *  so a landed capture's ANSI (the whole live window) is not retained past its parse. */
export function keepGapRecoveryScreen(
  recovery: GapRecovery,
  frame: GapScreenIdentity & { seq: number; capturedAt: number },
  read: () => RuntimeTerminalProjection | Promise<RuntimeTerminalProjection>
): void {
  const kept = recovery.keptScreen
  if (kept && sameStream(kept, frame) && kept.seq >= frame.seq) {
    return
  }
  const projection = Promise.resolve()
    .then(read)
    .catch(() => null)
  recovery.keptScreen = {
    generation: frame.generation,
    anchorRevision: frame.anchorRevision,
    seq: frame.seq,
    capturedAt: frame.capturedAt,
    read: () => projection
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
      { ...stream, seq: state.outputSequence, capturedAt: Date.now() },
      () => frame
    )
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
