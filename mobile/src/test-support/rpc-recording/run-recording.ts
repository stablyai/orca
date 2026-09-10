import { recordUnhandledRejections } from './unhandled-recording'
import {
  captureError,
  captureValue,
  observeSettlement,
  type Settlement,
  type RecordedValue
} from './recording-values'
import type {
  MountAdapter,
  Recording,
  RecordingScenario,
  RecordingScheduler,
  MountedOperation
} from './recording-scenario'
import { ScriptedRpcTransport } from './scripted-rpc-transport'

export async function runRecording(
  scenario: RecordingScenario,
  mount: MountAdapter,
  scheduler: RecordingScheduler
): Promise<Recording> {
  scheduler.start()
  const transport = new ScriptedRpcTransport()
  const effects: { name: string; value: RecordedValue }[] = []
  const settlements: Record<string, Settlement> = {}
  const recording: Recording = { scenario: scenario.id, checkpoints: [] }
  const effect = (name: string, value: unknown) => {
    effects.push({ name, value: captureValue(value) })
  }
  const stopUnhandled = recordUnhandledRejections(effect)
  let mounted: MountedOperation | undefined
  const ids = new Set<string>()
  try {
    mounted = mount({ client: transport.client, effect })
    for (const step of scenario.steps) {
      if ('action' in step) {
        if (ids.has(step.id)) {
          throw new Error(`Duplicate action: ${step.id}`)
        }
        ids.add(step.id)
        try {
          const value =
            step.action === 'disconnect'
              ? transport.disconnect()
              : step.action === 'cutover'
                ? transport.cutover()
                : mounted.action(step.action, step.args ?? {})
          observeSettlement(value, (state) => {
            settlements[step.id] = state
          })
        } catch (error) {
          settlements[step.id] = { status: 'rejected', error: captureError(error) }
        }
      } else if ('complete' in step) {
        transport.complete(step.complete, step.params, step.reply, step.reject)
      } else if ('bind' in step) {
        transport.bind(step.bind, step.request, step.params)
      } else if ('advance' in step) {
        await scheduler.advance(step.advance)
      }
      await scheduler.flush()
      if ('checkpoint' in step) {
        recording.checkpoints.push({
          id: step.checkpoint,
          observation: {
            sender: structuredClone(transport.requests) as unknown as RecordedValue,
            payloads: structuredClone(transport.payloads),
            settlements: structuredClone(settlements) as unknown as RecordedValue,
            state: captureValue(mounted.state()),
            effects: structuredClone(effects)
          }
        })
      }
    }
    if (!recording.checkpoints.length) {
      throw new Error(`No checkpoints: ${scenario.id}`)
    }
    return recording
  } finally {
    try {
      await mounted?.dispose()
      transport.dispose()
      await scheduler.flush()
    } finally {
      stopUnhandled()
      scheduler.stop()
    }
  }
}

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
