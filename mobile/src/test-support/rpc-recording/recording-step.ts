import { RecordingFault } from './recording-fault'
import {
  captureError,
  observeSettlement,
  rejectedSettlement,
  type Settlement
} from './recording-values'
import type { RecordingScenario, RecordingScheduler, MountedOperation } from './recording-scenario'
import { ScriptedRpcTransport } from './scripted-rpc-transport'

export function recordingStep(
  scenario: RecordingScenario,
  step: RecordingScenario['steps'][number],
  transport: ScriptedRpcTransport,
  mounted: MountedOperation,
  settlements: Record<string, Settlement>,
  scheduler: RecordingScheduler,
  effect: (name: string, value: unknown) => void,
  fault: RecordingFault,
  ids: Set<string>
): void {
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
      observeSettlement(
        value,
        scheduler.elapsed,
        (state) => {
          settlements[step.id] = state
        },
        (error) => fault.report('action settlement', error)
      )
    } catch (error) {
      settlements[step.id] = fault.capture('action rejection', () =>
        rejectedSettlement(error, scheduler.elapsed())
      )
    }
  } else if ('complete' in step) {
    const pending = transport.outstanding(step.complete)
    if (!step.optional || pending) {
      const params = step.optional && step.paramsFollowDivergence ? pending?.params : step.params
      transport.complete(step.complete, params, step.reply, step.reject)
    }
  } else if ('frame' in step) {
    const crash = transport.frame(step.frame, step.params, step.reply)
    if (crash) {
      // Record listener crashes as product outcomes; mismatched scenarios still throw.
      effect('stream-listener-crash', {
        frame: step.frame,
        error: captureError(crash.error)
      })
    }
  } else if ('bind' in step) {
    if (!step.optional || transport.outstanding(step.request)) {
      transport.bind(step.bind, step.request, step.params)
    }
  }
}

export function requireCheckpointClock(
  scenario: RecordingScenario,
  step: Extract<RecordingScenario['steps'][number], { checkpoint: string }>,
  scheduler: RecordingScheduler,
  advanced: number
): void {
  if (scheduler.elapsed() !== advanced) {
    throw new Error(
      `Checkpoint clock drifted: ${scenario.id} ${step.checkpoint} at ${scheduler.elapsed()}, scripted ${advanced}`
    )
  }
}
