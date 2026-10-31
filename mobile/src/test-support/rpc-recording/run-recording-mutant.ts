import type {
  MountAdapter,
  Recording,
  RecordingScenario,
  RecordingScheduler
} from './recording-scenario'

import { runRecording } from './run-recording'

export async function runRecordingMutant(
  scenario: RecordingScenario,
  mutatedMount: MountAdapter,
  scheduler: RecordingScheduler,
  baseline: Recording,
  project: (recording: Recording) => unknown = (recording) => recording
): Promise<{ verdict: 'killed' | 'survived'; recording: Recording }> {
  const recording = await runRecording(scenario, mutatedMount, scheduler)
  return {
    verdict:
      JSON.stringify(project(recording)) === JSON.stringify(project(baseline))
        ? 'survived'
        : 'killed',
    recording
  }
}
