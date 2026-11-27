// Electron-free: shared by the orchestration reader thread and its client.
import type { ConnectorWorkerCandidates } from '../connector-workers/connector-worker-candidates'

/** Each read the thread runs, by name, with its arguments and answer. */
export type OrchestrationReads = {
  connectorWorkerCandidates: {
    args: { sessionIds: readonly string[]; now: number }
    value: ConnectorWorkerCandidates
  }
}

export type OrchestrationReadName = keyof OrchestrationReads

export type OrchestrationReaderRequest = {
  [K in OrchestrationReadName]: {
    id: number
    /** The orchestration database file; main opens and migrates it first. */
    path: string
    read: K
    args: OrchestrationReads[K]['args']
  }
}[OrchestrationReadName]

export type OrchestrationReaderResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
