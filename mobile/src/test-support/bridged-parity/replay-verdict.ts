import type { BridgePortPair } from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import type { RpcClient } from '../../transport/rpc-client'
import type { Recording, RecordingScenario } from '../rpc-recording/recording-scenario'
import { absentResultExplainsResiduals } from './absent-result-evidence'
import { classifyBridgedParity } from './divergence-classes'
import { divergingFields, recordingWithoutRpcMeta } from './divergence-evidence'

export type BridgedReplay = {
  recording: Recording | null
  thrown: unknown
  pairs: BridgePortPair<RpcClient>[]
}

function certifyReplay(
  expected: Recording,
  scenarios: readonly RecordingScenario[],
  run: BridgedReplay,
  replyMeta: boolean
) {
  const actual =
    run.recording && (replyMeta ? recordingWithoutRpcMeta(run.recording, true) : run.recording)
  const fields = actual ? divergingFields(expected, actual) : []
  if (!actual || run.thrown !== null) {
    return { name: 'unclassified' as const, fields }
  }
  if (fields.length === 0) {
    return { name: 'identical' as const, fields }
  }
  return {
    name: classifyBridgedParity({
      fixedByReplyMeta: false,
      threwWhileRecording: false,
      divergingFields: fields,
      absentResultExplainsResiduals: absentResultExplainsResiduals(
        expected,
        actual,
        scenarios,
        run.pairs
      ),
      paramsMismatch: null,
      refusalReleasedStream: false
    }),
    fields
  }
}

/** Each replay must explain its own complete residuals before the counterfactual labels the pair. */
export function strictReplayVerdict(
  expected: Recording,
  scenarios: readonly RecordingScenario[],
  run: BridgedReplay,
  asIf: BridgedReplay
) {
  const original = certifyReplay(expected, scenarios, run, false)
  const replyMeta = certifyReplay(expected, scenarios, asIf, true)
  const name =
    original.name === 'unclassified' || replyMeta.name === 'unclassified'
      ? 'unclassified'
      : replyMeta.name === 'identical'
        ? original.name === 'identical'
          ? 'identical'
          : 'reply-meta-required'
        : replyMeta.name
  return { name, original, replyMeta } as const
}
