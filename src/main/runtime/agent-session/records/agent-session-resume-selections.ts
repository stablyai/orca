import {
  agentSessionResumeWitnessKey,
  type AgentSessionResumeMarker
} from '../../../../shared/agent-session/lifecycle/agent-session-resume-marker'
import {
  MAX_FAILURE_FIELD_LENGTH,
  normalizeState,
  type AgentSessionResumeFailureInput,
  type AgentSessionResumeFailureRecord,
  type RecoveryCapsuleState,
  type RecoveryEntry
} from './agent-session-recovery-capsule-entries'
import type { JournalWriteBody } from '../../../native-chat/agent-session-journal/writing/journal-write-queue'

type ResumeFrontier = {
  now: number
  run: (
    entries: ReadonlyMap<string, RecoveryEntry>,
    failed: ReadonlyMap<string, AgentSessionResumeFailureRecord>
  ) => () => void
  reject: (error: unknown) => void
}

export type AgentSessionResumeSelection = {
  marker: AgentSessionResumeMarker
  failedAt?: number
  failure?: AgentSessionResumeFailureRecord
  legacyAttempt?: { operationId: string; startedAt: number }
}

export type AgentSessionResumeDisposition =
  | { kind: 'complete' | 'cancelled' }
  | { kind: 'failed'; failure: AgentSessionResumeFailureInput }

function selectedResume(
  entry: RecoveryEntry | undefined,
  failure: AgentSessionResumeFailureRecord | undefined,
  selection: AgentSessionResumeSelection
): boolean {
  const key = agentSessionResumeWitnessKey(selection.marker)
  if (entry?.state === 'in-progress') {
    return false
  }
  return selection.failedAt === undefined
    ? entry?.state === 'pending' && agentSessionResumeWitnessKey(entry.marker) === key && !failure
    : failure?.failedAt === selection.failedAt &&
        agentSessionResumeWitnessKey(failure.marker) === key &&
        JSON.stringify(failure) === JSON.stringify(selection.failure)
}

export class AgentSessionResumeSelections {
  private readonly ready: ResumeFrontier[] = []
  private draining = false
  constructor(
    private readonly deps: {
      withLock: <T>(apply: () => Promise<T>) => Promise<T>
      readState: () => Promise<RecoveryCapsuleState>
      publish: (
        records: Pick<RecoveryCapsuleState, 'entries' | 'failed'>,
        now: number,
        dismissedAt?: number
      ) => Promise<void>
    }
  ) {}

  /** A failed read never retires another inventory's retained evidence. */
  inventory(now: number, observe: (sessionIds: string[]) => void) {
    return this.deps.withLock(async () => {
      const state = normalizeState(await this.deps.readState(), now)
      observe([
        ...state.entries.flatMap((entry) => [
          entry.marker.sessionId,
          ...(entry.state === 'in-progress' && entry.replacement
            ? [entry.replacement.sessionId]
            : [])
        ]),
        ...state.failed.map((failure) => failure.marker.sessionId)
      ])
      return {
        pending: state.entries
          .filter((entry) => entry.state === 'pending')
          .map((entry) => entry.marker),
        failed: state.failed
      }
    })
  }

  /** Capture exact pending witnesses; named actions may also retry settled failures. */
  selectResume(
    now: number,
    sessionIds?: readonly string[]
  ): Promise<AgentSessionResumeSelection[]> {
    return this.deps.withLock(async () => {
      const raw = await this.deps.readState()
      const state = normalizeState(raw, now)
      const requested = sessionIds === undefined ? null : new Set(sessionIds)
      const rawByWitness = new Map(
        raw.entries.map((entry) => [agentSessionResumeWitnessKey(entry.marker), entry])
      )
      const held = new Set(state.entries.map((entry) => entry.marker.sessionId))
      const selections: AgentSessionResumeSelection[] = state.entries.flatMap((entry) => {
        if (entry.state !== 'pending' || (requested && !requested.has(entry.marker.sessionId))) {
          return []
        }
        const previous = rawByWitness.get(agentSessionResumeWitnessKey(entry.marker))
        return [
          {
            marker: entry.marker,
            ...(previous?.state === 'in-progress' &&
            previous.operationId !== undefined &&
            previous.startedAt !== undefined
              ? {
                  legacyAttempt: {
                    operationId: previous.operationId,
                    startedAt: previous.startedAt
                  }
                }
              : {})
          }
        ]
      })
      for (const failure of state.failed) {
        if (requested?.has(failure.marker.sessionId) && !held.has(failure.marker.sessionId)) {
          selections.push({ marker: failure.marker, failedAt: failure.failedAt, failure })
        }
      }
      return selections
    })
  }

  /** Callers own their write queue; each callback is one synchronous acceptance transaction. */
  withSelectedResume<T>(
    selection: AgentSessionResumeSelection,
    now: number,
    accept: JournalWriteBody<T>
  ): Promise<{ selected: false } | { selected: true; value: T }> {
    return new Promise((resolve, reject) => {
      this.ready.push({
        now,
        reject,
        run: (entries, failed) => {
          try {
            const id = selection.marker.sessionId
            const result = selectedResume(entries.get(id), failed.get(id), selection)
              ? { selected: true as const, value: accept() }
              : { selected: false as const }
            return () => resolve(result)
          } catch (error) {
            return () => reject(error)
          }
        }
      })
      if (!this.draining) {
        this.draining = true
        void this.drainReady()
      }
    })
  }

  private async drainReady(): Promise<void> {
    let frontier: ResumeFrontier[] = []
    try {
      const settle = await this.deps.withLock(async () => {
        // Arrivals after this capture belong to the next finite drain.
        frontier = this.ready.splice(0)
        const now = frontier.reduce((latest, peer) => Math.max(latest, peer.now), 0)
        const state = normalizeState(await this.deps.readState(), now)
        const entries = new Map(state.entries.map((entry) => [entry.marker.sessionId, entry]))
        const failed = new Map(state.failed.map((failure) => [failure.marker.sessionId, failure]))
        return frontier.map((peer) => peer.run(entries, failed))
      })
      settle.forEach((finish) => finish())
    } catch (error) {
      // Lock acquisition may fail before a frontier is captured.
      if (frontier.length === 0) {
        frontier = this.ready.splice(0)
      }
      frontier.forEach((peer) => peer.reject(error))
    } finally {
      if (this.ready.length) {
        // Publication and queued dismissals get a turn before another fresh inventory read.
        setImmediate(() => {
          void this.drainReady()
        })
      } else {
        this.draining = false
      }
    }
  }

  /** Reconcile receipts synchronously under the lock; retire only the captured witness/version. */
  settleResume(
    selections: readonly AgentSessionResumeSelection[],
    now: number,
    reconcile: (selection: AgentSessionResumeSelection) => AgentSessionResumeDisposition | null
  ): Promise<void> {
    return this.deps.withLock(async () => {
      const raw = await this.deps.readState()
      const state = normalizeState(raw, now)
      const entries = new Map(state.entries.map((entry) => [entry.marker.sessionId, entry]))
      const failed = new Map(state.failed.map((failure) => [failure.marker.sessionId, failure]))
      let changed = false
      for (const selection of selections) {
        const id = selection.marker.sessionId
        if (!selectedResume(entries.get(id), failed.get(id), selection)) {
          continue
        }
        const disposition = reconcile(selection)
        if (!disposition) {
          continue
        }
        entries.delete(id)
        failed.delete(id)
        if (disposition.kind === 'failed') {
          const { sessionId: _sessionId, ...failure } = disposition.failure
          failed.set(id, {
            ...failure,
            marker: selection.marker,
            reason: failure.reason.slice(0, MAX_FAILURE_FIELD_LENGTH),
            latestPrompt: failure.latestPrompt.slice(0, MAX_FAILURE_FIELD_LENGTH)
          })
        }
        changed = true
      }
      if (changed) {
        await this.deps.publish(
          { entries: [...entries.values()], failed: [...failed.values()] },
          now,
          raw.dismissedAt
        )
      }
    })
  }

  /** Retire exact observed offers, including failed rows, without touching a newer interruption. */
  forgetWitnesses(markers: readonly AgentSessionResumeMarker[], now: number): Promise<void> {
    return this.deps.withLock(async () => {
      const raw = await this.deps.readState()
      const { entries, failed } = normalizeState(raw, now)
      const gone = new Set(markers.map(agentSessionResumeWitnessKey))
      const keptEntries = entries.filter(
        (entry) =>
          entry.state !== 'pending' || !gone.has(agentSessionResumeWitnessKey(entry.marker))
      )
      const keptFailures = failed.filter(
        (failure) => !gone.has(agentSessionResumeWitnessKey(failure.marker))
      )
      if (keptEntries.length !== entries.length || keptFailures.length !== failed.length) {
        await this.deps.publish(
          { entries: keptEntries, failed: keptFailures },
          now,
          raw.dismissedAt
        )
      }
    })
  }
}
