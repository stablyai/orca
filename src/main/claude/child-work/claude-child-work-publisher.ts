import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from '../structured/claude-structured-session-state'
import { drainClaudeChildWork } from './claude-child-work-evidence'

/** Frames arrive many times a second, but a subagent's first assistant row lands seconds later. */
const CHILD_EFFORT_PROBE_INTERVAL_MS = 2_000
/** Bound a missing transcript without polling for the whole session. */
const MAX_CHILD_EFFORT_PROBES = 30

/** NUL cannot appear in a session id or agent id. */
function childEffortProbeKey(sessionId: string, agentId: string): string {
  return `${sessionId}\u0000${agentId}`
}

type ChildEffortProbe = {
  attempts: number
  inFlight: boolean
  nextAt: number
  found: boolean
  /** The spawn call this probe read for; a resumed run must not reuse its result. */
  runId: string | undefined
}

/** Publishes child evidence, and fills in a subagent's effort from its own transcript once observed. */
export class ClaudeChildWorkPublisher {
  private readonly probes = new Map<string, ChildEffortProbe>()

  constructor(
    private readonly deps: Pick<
      ClaudeStructuredSessionAdapterDeps,
      'now' | 'readChildEffort' | 'onChildWorkEvidence'
    > & { sessions: ReadonlyMap<string, ClaudeSession> }
  ) {}

  publish(
    sessionId: string,
    session: ClaudeSession | null | undefined,
    message: Record<string, unknown> | null = null
  ): void {
    const evidence = drainClaudeChildWork(session, message, this.deps.now?.() ?? Date.now())
    if (evidence.length > 0) {
      this.deps.onChildWorkEvidence?.(sessionId, evidence, session?.events)
    }
    const read = this.deps.readChildEffort
    if (!read || !session) {
      return
    }
    for (const edge of evidence) {
      if (edge.type === 'ended' || edge.type === 'removed') {
        this.probes.delete(childEffortProbeKey(sessionId, edge.handle.id))
      } else if (edge.type === 'live' && edge.restart) {
        this.probes.delete(childEffortProbeKey(sessionId, edge.child.handle.id))
      }
    }
    // Any frame is a chance to retry a transcript that had not landed yet.
    for (const [id, task] of session.childWork.live) {
      if (task.kind !== 'agent') {
        continue
      }
      // A run change without a `restart` edge still owns a different transcript.
      const probe = this.probes.get(childEffortProbeKey(sessionId, id))
      if (probe && probe.runId !== task.toolUseId) {
        this.probes.delete(childEffortProbeKey(sessionId, id))
      }
      this.probeChildEffort(sessionId, session, id, task.toolUseId, read)
    }
  }

  forget(sessionId: string): void {
    for (const key of this.probes.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) {
        this.probes.delete(key)
      }
    }
  }

  private probeChildEffort(
    sessionId: string,
    session: ClaudeSession,
    agentId: string,
    runId: string | undefined,
    read: NonNullable<ClaudeStructuredSessionAdapterDeps['readChildEffort']>
  ): void {
    const now = this.deps.now?.() ?? Date.now()
    const key = childEffortProbeKey(sessionId, agentId)
    const probe = this.probes.get(key) ?? {
      attempts: 0,
      inFlight: false,
      nextAt: 0,
      found: false,
      runId
    }
    if (
      probe.inFlight ||
      probe.found ||
      probe.attempts >= MAX_CHILD_EFFORT_PROBES ||
      now < probe.nextAt
    ) {
      return
    }
    probe.attempts += 1
    probe.inFlight = true
    probe.nextAt = now + CHILD_EFFORT_PROBE_INTERVAL_MS
    this.probes.set(key, probe)
    void read(session, agentId).then(
      (effort) => {
        probe.inFlight = false
        if (effort === undefined || this.probes.get(key) !== probe) {
          return
        }
        // A read that outlived its session or run must not describe the new one.
        const live = this.deps.sessions.get(sessionId)
        if (live !== session || session.childWork.live.get(agentId)?.toolUseId !== probe.runId) {
          return
        }
        probe.found = true
        this.deps.onChildWorkEvidence?.(
          sessionId,
          [
            {
              type: 'operation',
              observedAt: this.deps.now?.() ?? Date.now(),
              childId: agentId,
              effort
            }
          ],
          live.events
        )
      },
      () => {
        probe.inFlight = false
      }
    )
  }
}
