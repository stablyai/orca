import { recordingStep, requireCheckpointClock } from './recording-step'
import { materializeScenario } from './scenario-execution-mode'
import { RecordingFault } from './recording-fault'
import { recordUnhandledRejections } from './unhandled-recording'
import { captureValue, type Settlement, type RecordedValue } from './recording-values'
import type {
  MountAdapter,
  Recording,
  RecordingScenario,
  RecordingScheduler,
  MountedOperation,
  Observation
} from './recording-scenario'
import { ScriptedRpcTransport, type ScriptedClientWrapper } from './scripted-rpc-transport'
import { createWriteOrdinal } from './write-ordinal'

export async function runRecording(
  scenario: RecordingScenario,
  mount: MountAdapter,
  scheduler: RecordingScheduler,
  wrapClient?: ScriptedClientWrapper
): Promise<Recording> {
  const ordinal = createWriteOrdinal()
  const fault = new RecordingFault()
  const effects: { name: string; ordinal: number; value: RecordedValue }[] = []
  const settlements: Record<string, Settlement> = {}
  const recording: Recording = { scenario: scenario.id, checkpoints: [] }
  const effect = (name: string, value: unknown) =>
    fault.capture('effect', () => {
      const captured = captureValue(value)
      effects.push({ name, ordinal: ordinal(), value: captured })
    })
  let transport: ScriptedRpcTransport | undefined
  let mounted: MountedOperation | undefined
  let stopUnhandled: (() => void) | undefined
  let schedulerAttempted = false
  let schedulerStarted = false
  let cleaned = false
  let checkingFault = false
  let body: { error: unknown } | undefined
  const cleanupErrors: unknown[] = []
  const attempt = async (cleanup: () => unknown) => {
    try {
      await cleanup()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  const check = () => {
    checkingFault = true
    fault.check()
    checkingFault = false
  }
  const snapshot = (state: RecordedValue): Observation =>
    fault.capture('snapshot', () => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the transport's captured attempts contain only Recording values.
      sender: structuredClone(transport!.requests) as unknown as RecordedValue,
      payloads: structuredClone(transport!.payloads),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settlements were captured at their original boundaries.
      settlements: structuredClone(settlements) as unknown as RecordedValue,
      state,
      effects: structuredClone(effects)
    }))
  const teardown = async () => {
    cleaned = true
    if (mounted) {
      await attempt(() => mounted!.dispose())
    }
    if (schedulerStarted) {
      await attempt(() => scheduler.flush())
    }
    if (transport) {
      await attempt(() => {
        const streams = transport!.registeredStreams()
        if (streams.length) {
          effect('streams-registered-at-teardown', streams)
        }
      })
      await attempt(() => transport!.dispose())
      if (schedulerStarted) {
        await attempt(() => scheduler.flush())
      }
      await attempt(() => transport!.causality.assertTransparentCalls())
      await attempt(() => transport!.causality.close())
    }
  }
  try {
    scenario = materializeScenario(scenario, scenario.lineage?.mode ?? 'native')
    schedulerAttempted = true
    await scheduler.start()
    schedulerStarted = true
    transport = new ScriptedRpcTransport(
      scheduler.elapsed,
      ordinal,
      wrapClient,
      fault,
      undefined,
      (acquired) => {
        transport = acquired
      }
    )
    stopUnhandled = recordUnhandledRejections(effect, (restore) => {
      stopUnhandled = restore
    })
    mounted = mount({
      client: transport.client,
      effect,
      captureObservation: (origin, read) => fault.capture(origin, read)
    })
    let advanced = 0
    const ids = new Set<string>()
    for (const step of scenario.steps) {
      if ('advance' in step) {
        advanced += step.advance
        await scheduler.advance(step.advance)
      } else {
        recordingStep(
          scenario,
          step,
          transport,
          mounted,
          settlements,
          scheduler,
          effect,
          fault,
          ids
        )
      }
      check()
      await scheduler.flush()
      check()
      if ('checkpoint' in step) {
        requireCheckpointClock(scenario, step, scheduler, advanced)
        recording.checkpoints.push({
          id: step.checkpoint,
          observation: snapshot(
            fault.capture('checkpoint state', () => captureValue(mounted!.state()))
          )
        })
      }
    }
    if (!recording.checkpoints.length) {
      throw new Error(`No checkpoints: ${scenario.id}`)
    }
    const beforeCleanup = JSON.stringify(
      snapshot(fault.capture('cleanup baseline', () => captureValue(mounted!.state())))
    )
    const stateAtCleanup = fault.capture('cleanup state', () => captureValue(mounted!.state()))
    await teardown()
    const afterCleanup = snapshot(stateAtCleanup)
    if (JSON.stringify(afterCleanup) !== beforeCleanup) {
      recording.checkpoints.push({ id: 'cleanup', observation: afterCleanup })
    }
  } catch (error) {
    if (!checkingFault) {
      body = { error }
    }
  } finally {
    if (!cleaned) {
      await teardown()
    }
    if (stopUnhandled) {
      await attempt(stopUnhandled)
    }
    if (schedulerAttempted) {
      await attempt(() => scheduler.stop())
    }
  }
  const errors = [
    ...(fault.failure ? [fault.failure.error] : []),
    ...(body ? [body.error] : []),
    ...cleanupErrors
  ]
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length) {
    throw new AggregateError(errors, 'Recording and cleanup failed')
  }
  return recording
}

export { runRecordingMutant } from './run-recording-mutant'
