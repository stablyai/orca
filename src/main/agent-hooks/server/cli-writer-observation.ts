import type { AgentProcessVerdict } from '../../../shared/agent-process-presence'

export type CliWriterObservation = {
  current: () => boolean
  presence: () => Promise<AgentProcessVerdict | null>
}
