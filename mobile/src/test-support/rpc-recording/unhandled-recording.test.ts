import { describe, expect, it } from 'vitest'
import { runRecording } from './run-recording'
import { recordUnhandledRejections } from './unhandled-recording'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import type { RecordingScenario } from './recording-scenario'

// No golden records an unhandled rejection any more, so these are the only things pinning the
// capture: the helper, and its wiring into a recording, where a dropped hookup would pass every
// golden.
describe('recordUnhandledRejections', () => {
  it('records a detached rejection as an effect and restores the prior listeners', async () => {
    const before = process.rawListeners('unhandledRejection')
    const effects: { name: string; value: unknown }[] = []

    const stop = recordUnhandledRejections((name, value) => effects.push({ name, value }))
    void Promise.reject(new TypeError("Cannot read properties of null (reading 'ui')"))
    await new Promise((resolve) => setImmediate(resolve))
    stop()

    expect(effects).toEqual([
      {
        name: 'unhandled-rejection',
        value: {
          category: 'TypeError',
          message: "Cannot read properties of null (reading 'ui')",
          isRpcDeliveryUnknown: false
        }
      }
    ])
    expect(process.rawListeners('unhandledRejection')).toEqual(before)
  })

  it('reaches a checkpoint and the cleanup checkpoint through a real recording', async () => {
    const scenario: RecordingScenario = {
      id: 'detached',
      operation: 'op',
      family: 'op',
      sites: [],
      schedules: [],
      steps: [{ action: 'fire', id: 'fire' }, { checkpoint: 'after-fire' }]
    }
    const recording = await runRecording(
      scenario,
      () => ({
        action: () => {
          void Promise.reject(new TypeError('detached in an action'))
        },
        state: () => ({}),
        dispose: () => {
          void Promise.reject(new Error('detached in cleanup'))
        }
      }),
      vitestRecordingScheduler()
    )
    const effects = (id: string) =>
      recording.checkpoints.find((checkpoint) => checkpoint.id === id)?.observation.effects
    expect(effects('after-fire')).toMatchObject([
      { name: 'unhandled-rejection', value: { message: 'detached in an action' } }
    ])
    expect(effects('cleanup')).toMatchObject([
      { name: 'unhandled-rejection', value: { message: 'detached in an action' } },
      { name: 'unhandled-rejection', value: { message: 'detached in cleanup' } }
    ])
  })
})
