import type { AgentSessionDispatchOutcome } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { JsonlRpcRecord } from '../../jsonl-rpc/peer'
import type { JsonlRpcRequestOptions } from '../../jsonl-rpc/peer-oversized-record'
import type { JsonlRpcTimelineLane } from '../../jsonl-rpc/timeline-lane'
import type { PiRpcState } from './rpc-protocol'

export type PiRpcTurnDeps = {
  lane: JsonlRpcTimelineLane
  generation: string
  send: (frame: JsonlRpcRecord) => Promise<void>
  request: (
    command: string,
    params?: Record<string, unknown>,
    options?: JsonlRpcRequestOptions
  ) => Promise<unknown>
  settled: (id: string, outcome: AgentSessionDispatchOutcome) => void
  /** Pi took this send, before it opens a turn for it; while one runs, it steers it into that turn.
   *  `opener`: the send that starts a run from idle, which joined no turn. */
  accepting?: (id: string, opener: boolean) => void
  idle: () => void
  /** Called after the timeline accepts the turn end. */
  turnEnded?: () => void
  failed: (error: Error) => void
  diagnostic?: (error: unknown) => void
  prepareStateObservation?: () => (state: PiRpcState) => void
}
