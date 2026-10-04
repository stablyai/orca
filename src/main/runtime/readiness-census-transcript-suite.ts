// The transcript half of the readiness census: each recording replayed chunk by chunk into a pane.
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import { checkCensusBaseline } from './readiness-census-baseline'
import {
  closePane,
  feedPane,
  observePane,
  useCensusEnvironment
} from './readiness-census-pane-probe'
import {
  censusPaneSubject,
  censusShard,
  type CensusPane
} from './readiness-census-transcript-catalog'

// Why 50 ms: at WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS the runtime's blocked scan runs inline rather
// than on a wall-clock timer, and 50 ms x the longest transcript stays far inside the 30-minute
// first-party status freshness window. Elapsed time between chunks reaches no other rule.
const FRAME_MS = 50
const BASE_TIME_MS = Date.UTC(2026, 0, 1)
// Why per replay: the longest takes several seconds alone, longer under full-suite load.
const REPLAY_TIMEOUT_MS = 120_000

async function replayCensusPane({
  transcript,
  pane
}: CensusPane): Promise<Record<'clocked' | 'clockless', string[]>> {
  vi.setSystemTime(BASE_TIME_MS)
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: transcript.foregroundProcess,
    data: '',
    ...(pane === 'agent' && transcript.agent ? { launchAgent: transcript.agent } : {}),
    size: { cols: transcript.cols, rows: transcript.rows }
  })
  const frames: Record<'clocked' | 'clockless', string[]> = { clocked: [], clockless: [] }
  for (const [index, chunk] of transcript.chunks().entries()) {
    // Why each frame restarts from its own time: every frame is a branch point, and a clock
    // carried past the previous frame's quiet probe would age first-party statuses.
    const at = BASE_TIME_MS + (index + 1) * FRAME_MS
    await feedPane(runtime, chunk, at)
    const observed = await observePane(runtime, handle, at)
    frames.clocked.push(observed.clocked)
    frames.clockless.push(observed.clockless)
  }
  closePane(runtime)
  return frames
}

export function describeTranscriptCensusShard(shard: number): void {
  describe(`readiness census: transcripts, shard ${shard}`, () => {
    useCensusEnvironment()
    it.each(censusShard(shard).map((pane) => [censusPaneSubject(pane), pane] as const))(
      '%s',
      async (subject, pane) => {
        const { transcript } = pane
        const diff = checkCensusBaseline(
          subject,
          `${transcript.agent ?? 'non-agent'} recording at ${transcript.cols}x${transcript.rows} replayed on the ${pane.pane} pane, one entry per chunk`,
          await replayCensusPane(pane)
        )
        expect(diff).toBe('')
      },
      REPLAY_TIMEOUT_MS
    )
  })
}
