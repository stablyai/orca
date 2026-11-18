import type {
  GapRecovery,
  RuntimeHeadlessTerminal
} from '../records/runtime-terminal-state-records'
import { extractHiddenStartupRendererQueryData } from '../../../../shared/terminal/protocol/queries/terminal-reply-query-extraction'

/** Splits a live chunk at the provider snapshot seed: `covered` is already in the seed, `uncovered` (null: none) still needs parsing. */
export function splitAtProviderSeed(
  state: RuntimeHeadlessTerminal,
  data: string,
  outputSequence: number,
  rawChunk: boolean
): { covered: string; uncovered: string | null; startsAtSeed: boolean } {
  const seed = state.providerSeed
  if (seed === undefined) {
    return { covered: '', uncovered: data, startsAtSeed: false }
  }
  if (outputSequence <= seed.seq) {
    return { covered: data, uncovered: null, startsAtSeed: false }
  }
  if (!rawChunk) {
    return { covered: '', uncovered: data, startsAtSeed: false }
  }
  // Why: the daemon merges emissions, so a chunk can straddle the snapshot; only an untransformed one maps to raw seq.
  const coveredChars = seed.seq - (outputSequence - data.length)
  return coveredChars > 0
    ? {
        covered: data.slice(0, coveredChars),
        uncovered: data.slice(coveredChars),
        startsAtSeed: true
      }
    : { covered: '', uncovered: data, startsAtSeed: coveredChars === 0 }
}

/** The seed already painted covered bytes, but the program still waits on their queries, as with daemon-dropped ones. */
export async function answerSeedCoveredQueries(
  state: RuntimeHeadlessTerminal,
  covered: string,
  forwardQueryReplies: boolean
): Promise<void> {
  const seed = state.providerSeed
  if (!seed || covered === '') {
    return
  }
  const extracted = extractHiddenStartupRendererQueryData(covered, seed.queryCarry)
  seed.queryCarry = extracted.pending
  const queries =
    extracted.statelessQueryData + extracted.statefulQueryData + extracted.oscColorQueryData
  if (forwardQueryReplies && queries) {
    await state.emulator.write(queries, { forwardQueryReplies: true })
  }
}

// Bounds what recovering models hold while captures wait; past it, bytes count as dropped output.
const GAP_RECOVERY_QUEUE_CAP_CHARS = 256 * 1024
const GAP_RECOVERY_TOTAL_QUEUE_CAP_CHARS = 32 * 1024 * 1024
const GAP_RECOVERY_PENDING_QUERY_CAP_CHARS = 4096
const GAP_RECOVERY_SUPPRESSED_TAIL_CHARS = 4096
let recoveryQueuedCharsTotal = 0

export function newGapRecovery(frontier: number, carried?: GapRecovery): GapRecovery {
  return {
    frontier,
    capturing: false,
    queuedChars: 0,
    queryCarry: carried?.queryCarry ?? '',
    pendingQueries: carried?.pendingQueries ?? [],
    pendingQueryChars: carried?.pendingQueryChars ?? 0,
    suppressedTail: carried?.suppressedTail ?? '',
    suppressedAt: carried?.suppressedAt ?? 0
  }
}

export function releaseRecoveryQueue(recovery: GapRecovery | undefined, chars: number): void {
  if (recovery) {
    recovery.queuedChars -= chars
    recoveryQueuedCharsTotal -= chars
  }
}

/** Whether a live chunk joins the recovering model's queue; either way its queries are owed once the seed covers it. */
export function admitWhileRecovering(
  state: RuntimeHeadlessTerminal,
  data: string,
  outputSequence: number,
  forwardQueryReplies: boolean,
  at: number
): { queued: boolean; recovery: GapRecovery | undefined } {
  const recovery = state.gapReseed
  if (!recovery) {
    return { queued: true, recovery }
  }
  // One carry across every chunk, queued or not, so a query split between them still completes.
  const extracted = extractHiddenStartupRendererQueryData(data, recovery.queryCarry)
  recovery.queryCarry = extracted.pending
  const queries =
    extracted.statelessQueryData + extracted.statefulQueryData + extracted.oscColorQueryData
  if (
    forwardQueryReplies &&
    queries &&
    recovery.pendingQueryChars + queries.length <= GAP_RECOVERY_PENDING_QUERY_CAP_CHARS
  ) {
    recovery.pendingQueries.push({ seq: outputSequence, data: queries })
    recovery.pendingQueryChars += queries.length
  }
  if (
    recovery.capturing &&
    recovery.queuedChars + data.length <= GAP_RECOVERY_QUEUE_CAP_CHARS &&
    recoveryQueuedCharsTotal + data.length <= GAP_RECOVERY_TOTAL_QUEUE_CAP_CHARS
  ) {
    recovery.queuedChars += data.length
    recoveryQueuedCharsTotal += data.length
    return { queued: true, recovery }
  }
  if (recovery.capturing) {
    // The capture may already be past this chunk, so the snapshot must reach beyond it.
    recovery.frontier = Math.max(recovery.frontier, outputSequence)
  }
  recovery.suppressedTail = (recovery.suppressedTail + data).slice(
    -GAP_RECOVERY_SUPPRESSED_TAIL_CHARS
  )
  recovery.suppressedAt = at
  return { queued: false, recovery }
}

/** Queries owed by chunks the seed covers, in arrival order; later ones are answered when their bytes parse. */
export function takeSeedCoveredQueries(recovery: GapRecovery, seedSeq: number): string {
  const covered = recovery.pendingQueries.filter((entry) => entry.seq <= seedSeq)
  recovery.pendingQueries = recovery.pendingQueries.filter((entry) => entry.seq > seedSeq)
  recovery.pendingQueryChars = recovery.pendingQueries.reduce((n, e) => n + e.data.length, 0)
  return covered.map((entry) => entry.data).join('')
}

/** Applies the provider seed to a live chunk: answers queries in its covered part and replays the seed's
 *  open escape before the rest. `data` is what still needs parsing (null: the seed covers it all). */
export async function consumeSeedCoverage(
  state: RuntimeHeadlessTerminal,
  chunk: string,
  outputSequence: number,
  opts: { rawChunk: boolean; forwardQueryReplies: boolean; recoveryAdmitted: boolean }
): Promise<{ covered: string; data: string | null }> {
  const { covered, uncovered, startsAtSeed } = splitAtProviderSeed(
    state,
    chunk,
    outputSequence,
    opts.rawChunk
  )
  // Fully covered chunks admitted while recovering owe their queries through the recovery instead.
  const straddlesSeed = outputSequence > (state.providerSeed?.seq ?? Infinity)
  await answerSeedCoveredQueries(
    state,
    covered,
    opts.forwardQueryReplies && (!opts.recoveryAdmitted || straddlesSeed)
  )
  if (uncovered === null) {
    return { covered, data: null }
  }
  const seedEscapeTail = state.providerSeed?.escapeTail
  state.providerSeed = undefined
  // A chunk that does not begin exactly at the seed already carries its own escape start.
  if (seedEscapeTail && startsAtSeed) {
    await state.emulator.write(seedEscapeTail)
  }
  return { covered, data: uncovered }
}
