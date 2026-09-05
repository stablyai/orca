import type {
  AgentThroughputClearIpcPayload,
  AgentThroughputSample
} from '../../shared/agent-throughput-types'

export type AgentThroughputApi = {
  /** Listen for per-pane generation throughput samples from the local hook server. */
  onSet: (callback: (sample: AgentThroughputSample) => void) => () => void
  onClear: (callback: (data: AgentThroughputClearIpcPayload) => void) => () => void
  /** Pull cached samples after renderer hydration so startup pushes aren't lost. */
  getSnapshot: () => Promise<AgentThroughputSample[]>
}
