import type { RuntimeHeadlessTerminal } from '../records/runtime-terminal-state-records'
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
let recoveryQueuedCharsTotal = 0

export function releaseRecoveryQueue(
  recovery: RuntimeHeadlessTerminal['gapReseed'],
  chars: number
): void {
  if (recovery) {
    recovery.queuedChars -= chars
    recoveryQueuedCharsTotal -= chars
  }
}

/** While a model recovers, admit a live chunk whole, or past the cap only its queries, raising the frontier past the rest. */
export function admitWhileRecovering(
  state: RuntimeHeadlessTerminal,
  data: string,
  outputSequence: number
): { data: string; queriesOnly: boolean; recovery: RuntimeHeadlessTerminal['gapReseed'] } {
  const recovery = state.gapReseed
  if (!recovery) {
    return { data, queriesOnly: false, recovery }
  }
  if (
    recovery.queuedChars + data.length <= GAP_RECOVERY_QUEUE_CAP_CHARS &&
    recoveryQueuedCharsTotal + data.length <= GAP_RECOVERY_TOTAL_QUEUE_CAP_CHARS
  ) {
    recovery.queuedChars += data.length
    recoveryQueuedCharsTotal += data.length
    return { data, queriesOnly: false, recovery }
  }
  recovery.frontier = Math.max(recovery.frontier, outputSequence)
  const extracted = extractHiddenStartupRendererQueryData(data, recovery.queryCarry)
  recovery.queryCarry = extracted.pending
  return {
    data: extracted.statelessQueryData + extracted.statefulQueryData + extracted.oscColorQueryData,
    queriesOnly: true,
    recovery
  }
}

/** Overflowed bytes during recovery are dropped, but the program still waits on their queries. */
export function answerQueriesAfterRecovery(
  state: RuntimeHeadlessTerminal,
  queries: string,
  forwardQueryReplies: boolean
): void {
  if (!queries || !forwardQueryReplies) {
    return
  }
  state.writeChain = state.writeChain
    .then(async () => {
      // Why drop, not retry: injecting mid-escape corrupts live parsing.
      if (state.emulator.partialEscapeTailAnsi === '') {
        await state.emulator.write(queries, { forwardQueryReplies: true })
      }
    })
    .catch(() => {})
}
