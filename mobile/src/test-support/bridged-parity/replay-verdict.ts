import type { BridgePortPair } from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import type { RpcClient } from '../../transport/rpc-client'
import type { Recording, RecordingScenario } from '../rpc-recording/recording-scenario'
import { absentResultExplainsResiduals } from './absent-result-evidence'
import { classifyBridgedParity } from './divergence-classes'
import { divergingFields } from './divergence-evidence'

export type BridgedReplay = {
  recording: Recording | null
  comparison?: Recording
  didThrow: boolean
  thrown: unknown
  pairs: Pick<BridgePortPair<RpcClient>, 'toShell' | 'toPage' | 'diagnostics' | 'hostDiagnostics'>[]
}

function replayDifference(
  expected: Recording,
  scenarios: readonly RecordingScenario[],
  run: BridgedReplay
) {
  const actual = run.comparison ?? run.recording
  const fields = actual ? divergingFields(expected, actual) : []
  if (run.didThrow || !actual) {
    return { name: 'unclassified' as const, fields }
  }
  if (!fields.length) {
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
        run.pairs,
        run.recording!
      ),
      paramsMismatch: null,
      refusalReleasedStream: false
    }),
    fields
  }
}

// Callers verify any declared probe projection before passing a comparison view.
export function strictReplayVerdict(
  expected: Recording,
  scenarios: readonly RecordingScenario[],
  run: BridgedReplay,
  asIf: BridgedReplay
) {
  const original = replayDifference(expected, scenarios, run)
  const replyMeta = replayDifference(expected, scenarios, asIf)
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
