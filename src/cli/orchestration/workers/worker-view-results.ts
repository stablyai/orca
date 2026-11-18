// What workerShow and workerList answer, as the CLI reads it; import-free so tsconfig.node.json can list it.

export type WorkerProjection = {
  runId?: string
  outcome?: string | null
  provider?: { id: string; model: string | null } | null
  host: { id: string }
  workspace?: { id: string } | null
  stage: { activity: string }
  liveness: { verdict: string; detail?: string }
  evidence?: { lastObservedAt: number | null }
  nextAction: { argv: string[] }
  attention?: { categories: string[] }
  // An absent resource carries only its state.
  resource?: { state?: string; terminalState?: string | null } | null
  autoReleaseAt?: string
}

export type NativeUsageInterval =
  | {
      status: 'closed'
      basis: 'fresh_session_exclusive_interval'
      transcriptPath: string
      file: { dev: number; ino: number; birthtimeMs: number }
      startOffset: 0
      endOffset: number
      sha256: string
      closedAt: number
    }
  | { status: 'unavailable'; reason: string }

/** Session observation only; it does not establish ownership of usage. */
export type NativeUsageIdentity =
  | {
      status: 'observed'
      agent: string
      sessionId: string
      paneKey: string
      processIncarnation: string
      hostScope: string
      launchTokenHash: string
      observedAt: number
      profile: { status: 'unavailable'; reason: 'profile_not_verified' }
      usageAttribution: { status: 'unavailable'; reason: 'segment_ownership_unproven' }
      /** Exact byte range [startOffset, endOffset) of the fresh session's transcript owned by this dispatch. */
      usageInterval?: NativeUsageInterval
    }
  | { status: 'unavailable'; reason: 'session_not_reported' | 'session_changed_or_shared' }

export type WorkerShowResult = {
  dispatch: {
    id: string
    taskId: string
    runId?: string
    status: string
    followUpOf?: string | null
  } | null
  /** Absent on older runtimes. */
  nativeUsageIdentity?: NativeUsageIdentity
  worker: {
    dispatchId?: string
    state: string
    stage: string
    agentTerminalHandle: string | null
    worktreeId?: string | null
    lastError?: string | null
  }
  projection?: WorkerProjection | null
  terminalResource?: {
    releaseState?: string | null
    terminalHandle?: string | null
  } | null
  observation?: { agentWait?: { source: string; reason?: string } | null; reason?: string }
  /** Present only for a worker a paired server runs, which this Orca's record answers. */
  server?: RemoteWorkerServer & { reachable?: boolean }
  lastReport?: string | null
  autoReleaseAt?: string | null
  /** The paired Orca whose Run here coordinates this worker. */
  coordinatedFrom?: string | null
}

/** A worker a paired server runs, as this Orca names that server and last heard from it. */
export type RemoteWorkerServer = { name: string; asOf: string; repaired?: true }

export type WorkerListResult = {
  workers: {
    dispatchId: string
    taskId: string
    runId: string
    workerState: string
    dispatchStatus: string
    agentTerminalHandle: string | null
    terminalState: string | null
    coordinatedFrom?: string | null
    resource?: { worktreeId?: string | null; autoReleaseAt?: string | null } | null
    projection?: WorkerProjection
    /** Only on a worker a paired server runs, listed from this Orca's record of it. */
    server?: RemoteWorkerServer
  }[]
  counts: Record<string, number>
  page?: { hasMore: boolean; nextCursor: string | null; total: number }
  warnings?: string[]
  partialHostErrors?: {
    environmentId: string
    name: string
    code: string
    dispatchIds: string[]
  }[]
}
