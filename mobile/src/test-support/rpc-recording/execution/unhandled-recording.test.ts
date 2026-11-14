import { describe, expect, it } from 'vitest'
import { runRecording } from '../run-recording'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import type { RecordingScenario } from '../scenarios/recording-scenario'

// No corpus golden has detached rejections; pin capture and recording integration directly.
describe('recordUnhandledRejections', () => {
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
      recording.checkpoints.find((checkpoint) => checkpoint.id === id)!.observation.effects
    expect(effects('after-fire')).toMatchObject([
      { name: 'unhandled-rejection', value: { message: 'detached in an action' } }
    ])
    expect(effects('cleanup')).toMatchObject([
      { name: 'unhandled-rejection', value: { message: 'detached in an action' } },
      { name: 'unhandled-rejection', value: { message: 'detached in cleanup' } }
    ])
  })
})
