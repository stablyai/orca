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
