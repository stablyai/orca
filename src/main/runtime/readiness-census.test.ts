/**
 * The readiness census (STA-9098): today's tui-idle verdicts, pinned so a refactor of the readiness
 * rules can prove it changed none of them.
 *
 * - Transcripts (readiness-census-transcripts-<shard>.test.ts): every recorded agent PTY transcript
 *   is replayed chunk by chunk into a real runtime pane at its recorded grid, once with the agent
 *   known and once agent-unknown. Each frame records the ranked verdict the moment the chunk lands
 *   and had the stream then gone quiet, what `terminal wait --for tui-idle` started there returns
 *   (at once or on its first poll tick), and the same on a clockless (restored or adopted) pane.
 * - Synthetic (readiness-census-synthetic.test.ts): every TuiAgent under a bounded matrix of title,
 *   first-party status, screen, foreground process and output clock
 *   (readiness-census-synthetic-matrix.ts says which cross-product and why).
 *
 * Baselines live in __fixtures__/readiness-census/, one per replayed pane (run-length encoded per
 * frame) or agent. Any difference fails with the subject and frames or cases that changed. If the change is intended, regenerate with
 *
 *   UPDATE_READINESS_CENSUS=1 pnpm test src/main/runtime/readiness-census
 *
 * and review the JSON diff (the commit hook's oxfmt pass reflows it; the census only parses it).
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeCensusDiff, runLengthDecode, runLengthEncode } from './readiness-census-baseline'
import { CENSUS_AGENTS } from './readiness-census-synthetic-matrix'
import {
  CENSUS_PANES,
  CENSUS_SHARD_COUNT,
  censusPaneSubject,
  censusShard
} from './readiness-census-transcript-catalog'

describe('readiness census coverage', () => {
  it('replays every pane in exactly one shard', () => {
    const sharded = Array.from({ length: CENSUS_SHARD_COUNT }, (_, index) =>
      censusShard(index + 1)
    ).flat()
    expect(sharded.map(censusPaneSubject).toSorted()).toEqual(
      CENSUS_PANES.map(censusPaneSubject).toSorted()
    )
  })

  it('keeps exactly one baseline per replayed pane and synthetic agent', () => {
    const subjects = [
      ...CENSUS_PANES.map(censusPaneSubject),
      ...CENSUS_AGENTS.map((agent) => `synthetic/${agent}`)
    ].map((subject) => `${subject.replaceAll('/', '--')}.json`)
    const stored = readdirSync(join(__dirname, '__fixtures__', 'readiness-census'))
    expect(stored.toSorted()).toEqual(subjects.toSorted())
  })
})
describe('readiness census baseline encoding', () => {
  it('round-trips frames through run-length lines', () => {
    const frames = ['a', 'a', 'b', 'a', 'a', 'a']
    expect(runLengthEncode(frames)).toEqual(['0-1: a', '2: b', '3-5: a'])
    expect(runLengthDecode(runLengthEncode(frames))).toEqual(frames)
  })

  it('names the pane and frames that changed', () => {
    const diff = describeCensusDiff(
      'transcript/codex@agent',
      { clocked: ['x', 'x', 'y', 'y', 'z'] },
      { clocked: ['x', 'w', 'w', 'y', 'z'] }
    )
    expect(diff).toEqual([
      'transcript/codex@agent clocked [1]:\n    was: x\n    now: w',
      'transcript/codex@agent clocked [2]:\n    was: y\n    now: w'
    ])
  })
})
