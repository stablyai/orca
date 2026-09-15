import { recordUnhandledRejections } from './unhandled-recording'
import {
  captureValue,
  observeSettlement,
  rejectedSettlement,
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
  const transport = new ScriptedRpcTransport(scheduler.elapsed)
  const effects: { name: string; value: RecordedValue; sent: number }[] = []
  const settlements: Record<string, Settlement> = {}
  const recording: Recording = { scenario: scenario.id, checkpoints: [] }
  const effect = (name: string, value: unknown) => {
    // Why the send count: sender and effects are two independent lists, so a send reordered ahead of
    // a device write moves neither of them. Stamping the count at push time orders them against
    // each other, and that reordering becomes a golden diff.
    effects.push({ name, value: captureValue(value), sent: transport.requests.length })
  }
  const stopUnhandled = recordUnhandledRejections(effect)
  let mounted: MountedOperation | undefined
  const ids = new Set<string>()
  let advanced = 0
  let cleaned = false
  const teardown = async (): Promise<void> => {
    cleaned = true
    await mounted?.dispose()
    transport.dispose()
    await scheduler.flush()
  }
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
          observeSettlement(value, scheduler.elapsed, (state) => {
            settlements[step.id] = state
          })
        } catch (error) {
          settlements[step.id] = rejectedSettlement(error, scheduler.elapsed())
        }
      } else if ('complete' in step) {
        if (!step.optional || transport.outstanding(step.complete)) {
          transport.complete(step.complete, step.params, step.reply, step.reject)
        }
      } else if ('bind' in step) {
        if (!step.optional || transport.outstanding(step.request)) {
          transport.bind(step.bind, step.request, step.params)
        }
      } else if ('advance' in step) {
        advanced += step.advance
        await scheduler.advance(step.advance)
      }
      await scheduler.flush()
      if ('checkpoint' in step) {
        // A checkpoint's own clock is the sum of the scripted advances, so recording it would add
        // bytes and no signal. Asserted rather than recorded, so a future drift fails loudly.
        if (scheduler.elapsed() !== advanced) {
          throw new Error(
            `Checkpoint clock drifted: ${scenario.id} ${step.checkpoint} at ${scheduler.elapsed()}, scripted ${advanced}`
          )
        }
        recording.checkpoints.push({
          id: step.checkpoint,
          observation: {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a structured clone of recorded requests is recorded data.
            sender: structuredClone(transport.requests) as unknown as RecordedValue,
            payloads: structuredClone(transport.payloads),
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a structured clone of recorded settlements is recorded data.
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
    // Why cleanup runs here and not only in `finally`: each checkpoint clones `effects`, so a
    // rejection or state write produced by dispose, transport teardown or the final flush landed
    // after the recording was built and never reached a golden. Unmount leaks are exactly what
    // this oracle exists to catch, so teardown happens on the recorded path and anything it
    // observes becomes its own checkpoint. `state` is captured before dispose because the
    // operation is gone afterwards.
    const beforeCleanup = effects.length
    const stateAtCleanup = captureValue(mounted.state())
    await teardown()
    if (effects.length !== beforeCleanup) {
      recording.checkpoints.push({
        id: 'cleanup',
        observation: {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a structured clone of recorded requests is recorded data.
          sender: structuredClone(transport.requests) as unknown as RecordedValue,
          payloads: structuredClone(transport.payloads),
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a structured clone of recorded settlements is recorded data.
          settlements: structuredClone(settlements) as unknown as RecordedValue,
          state: stateAtCleanup,
          effects: structuredClone(effects)
        }
      })
    }
    return recording
  } finally {
    try {
      if (!cleaned) {
        await teardown()
      }
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
