import { describe, expect, it } from 'vitest'
import { runRecording } from './run-recording'
import { reactActQueuePrimed, vitestRecordingScheduler } from './vitest-recording-scheduler'
import type { MountAdapter, RecordingScenario } from './recording-scenario'

/** The seeded generator's first value: `seed = 1`, one LCG step, divided by 2^32. */
const SEEDED_FIRST_DRAW = 0.23645552527159452

const drawing: MountAdapter = ({ effect }) => ({
  action: (name) => {
    if (name !== 'draw') {
      throw new Error(`Unexpected action: ${name}`)
    }
    effect('draw', Math.random())
    return undefined
  },
  state: () => null,
  dispose: () => {}
})

/** `flushFirst` puts a zero-time drain — one `await act` — ahead of the draw. */
function scenario(id: string, flushFirst: boolean): RecordingScenario {
  const draw: RecordingScenario['steps'] = [{ action: 'draw', id: 'd' }, { checkpoint: 'drawn' }]
  return {
    id,
    operation: 'scheduler-determinism',
    version: 1,
    family: 'scheduler-determinism',
    sites: [],
    schedules: [],
    steps: flushFirst ? [{ checkpoint: 'mounted' }, ...draw] : draw
  }
}

async function record(id: string, flushFirst: boolean): Promise<unknown> {
  const recording = await runRecording(
    scenario(id, flushFirst),
    drawing,
    vitestRecordingScheduler()
  )
  const drawn = recording.checkpoints.at(-1)?.observation.effects
  return JSON.parse(JSON.stringify(drawn))
}

describe('recording scheduler randomness', () => {
  // Must stay the first test in this file: React pays its one lazy draw per process, so only the
  // process's first recording can witness a scheduler that fails to absorb it. The `primed` guard
  // fails loudly rather than passing vacuously if anything records ahead of it.
  it('draws the same seeded value first in the process as afterwards', async () => {
    expect(reactActQueuePrimed()).toBe(false)
    const first = await record('first-in-process', true)
    const later = await record('later-in-process', true)
    const expected = [{ name: 'draw', ordinal: 1, value: SEEDED_FIRST_DRAW }]
    expect([first, later]).toEqual([expected, expected])
  })

  // An adapter that drew before the first drain used to sidestep the problem by consuming the
  // seeded value ahead of React; both placements now record the same one, so that is not a fix an
  // adapter has to arrange.
  it('draws the same seeded value before the first drain as after it', async () => {
    expect(await record('draw-before-drain', false)).toEqual([
      { name: 'draw', ordinal: 1, value: SEEDED_FIRST_DRAW }
    ])
  })
})
