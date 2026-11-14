import {
  AgentSessionResumeSelections,
  type AgentSessionResumeSelection
} from './agent-session-resume-selections'
export type {
  AgentSessionResumeSelection,
  AgentSessionResumeDisposition
} from './agent-session-resume-selections'
import { join } from 'node:path'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/agent-session-resume-marker'
import { readRecoveryCapsule, publishRecoveryCapsule } from './agent-session-recovery-capsule-file'
import { withFileTransactionLock } from '../../../filesystem/file-transaction-lock'
import type { JournalWriteBody } from '../../../native-chat/agent-session-journal/writing/journal-write-queue'
import {
  MAX_FAILURE_FIELD_LENGTH,
  normalizeState,
  shouldReplaceMarker,
  splitDismissedAll,
  type AgentSessionResumeFailureInput,
  type AgentSessionResumeFailureRecord,
  type KeepRecord,
  type RecoveryCapsuleState,
  type RecoveryEntry
} from './agent-session-recovery-capsule-entries'

export const AGENT_SESSION_RECOVERY_CAPSULE_FILE = 'agent-session-recovery.json'

type StoredRecords = Pick<RecoveryCapsuleState, 'entries' | 'failed'>

const capsuleTransactions = new Map<string, Promise<unknown>>()

/** Durable, per-session restart offers. Listing never spends an offer. */
export class AgentSessionRecoveryCapsule {
  private readonly filePath: string

  constructor(stateDirectory: string) {
    this.filePath = join(stateDirectory, AGENT_SESSION_RECOVERY_CAPSULE_FILE)
  }

  private readonly selections = new AgentSessionResumeSelections({
    withLock: (apply) => this.withLock(apply),
    readState: () => this.readState(),
    publish: (records, now, dismissedAt) => this.publish(records, now, dismissedAt)
  })
  selectResume(...args: Parameters<AgentSessionResumeSelections['selectResume']>) {
    return this.selections.selectResume(...args)
  }
  withSelectedResume<T>(
    selection: AgentSessionResumeSelection,
    now: number,
    accept: JournalWriteBody<T>
  ) {
    return this.selections.withSelectedResume(selection, now, accept)
  }
  settleResume(...args: Parameters<AgentSessionResumeSelections['settleResume']>) {
    return this.selections.settleResume(...args)
  }
  forgetWitnesses(...args: Parameters<AgentSessionResumeSelections['forgetWitnesses']>) {
    return this.selections.forgetWitnesses(...args)
  }

  list(now: number): Promise<AgentSessionResumeMarker[]> {
    return this.withLock(async () => {
      const { entries } = normalizeState(await this.readState(), now)
      return entries.filter((entry) => entry.state === 'pending').map((entry) => entry.marker)
    })
  }

  inventory(...args: Parameters<AgentSessionResumeSelections['inventory']>) {
    return this.selections.inventory(...args)
  }

  /** Read settled failed actions without consuming their records. */
  listFailed(now: number): Promise<AgentSessionResumeFailureRecord[]> {
    return this.withLock(async () => normalizeState(await this.readState(), now).failed)
  }

  /** Adds fresh teardown witnesses while preserving an action already in progress. */
  record(markers: readonly AgentSessionResumeMarker[], now: number): Promise<void> {
    return this.withLock(async () => {
      const state = await this.readState()
      const { entries, failed } = normalizeState(state, now)
      const bySession = new Map(entries.map((entry) => [entry.marker.sessionId, entry]))
      const failedBySession = new Map(failed.map((failure) => [failure.marker.sessionId, failure]))
      const dismissedAt = state.dismissedAt
      for (const marker of markers) {
        if (dismissedAt !== undefined && marker.recordedAt <= dismissedAt) {
          continue
        }
        const existing = bySession.get(marker.sessionId)
        if (existing?.state === 'in-progress') {
          const current = existing.replacement ?? existing.marker
          if (
            shouldReplaceMarker(current, marker) &&
            (marker.recordedAt > current.recordedAt || marker.teardownId !== current.teardownId)
          ) {
            bySession.set(marker.sessionId, { ...existing, replacement: marker })
          }
          continue
        }
        const failure = failedBySession.get(marker.sessionId)
        if (
          (existing && !shouldReplaceMarker(existing.marker, marker)) ||
          (failure && !shouldReplaceMarker(failure.marker, marker))
        ) {
          continue
        }
        // A newer witness than a recorded failure supersedes it when the records are normalized.
        bySession.set(marker.sessionId, { state: 'pending', marker })
      }
      // Keep dismissal fences across newer interruptions; older delayed writers must not resurrect offers.
      await this.publish({ entries: [...bySession.values()], failed }, now, dismissedAt)
    })
  }

  /** Reserve selected offers for one user action; failures retry only when named explicitly.
   * Preserve failure guidance until the retry settles. */
  beginResume(
    sessionIds: readonly string[] | undefined,
    operationId: string,
    now: number
  ): Promise<AgentSessionResumeMarker[]> {
    return this.withLock(async () => {
      const state = await this.readState()
      const { entries, failed } = normalizeState(state, now)
      const requested = sessionIds === undefined ? null : new Set(sessionIds)
      const selected: AgentSessionResumeMarker[] = []
      const reserve = (marker: AgentSessionResumeMarker): RecoveryEntry => {
        selected.push(marker)
        return { state: 'in-progress', operationId, startedAt: now, marker }
      }
      const next = entries.map((entry) =>
        entry.state === 'pending' && (requested === null || requested.has(entry.marker.sessionId))
          ? reserve(entry.marker)
          : entry
      )
      const held = new Set(entries.map((entry) => entry.marker.sessionId))
      for (const failure of failed) {
        if (requested?.has(failure.marker.sessionId) && !held.has(failure.marker.sessionId)) {
          next.push(reserve(failure.marker))
        }
      }
      await this.publish({ entries: next, failed }, now, state.dismissedAt)
      return selected
    })
  }

  completeResume(operationId: string, sessionIds: readonly string[], now: number): Promise<void> {
    return this.withLock(async () => {
      const selected = new Set(sessionIds)
      const state = await this.readState()
      const { entries, failed } = normalizeState(state, now)
      const completed = new Set<string>()
      const next = entries.flatMap((entry) => {
        if (!this.owns(entry, operationId) || !selected.has(entry.marker.sessionId)) {
          return [entry]
        }
        completed.add(entry.marker.sessionId)
        return entry.replacement ? [{ state: 'pending' as const, marker: entry.replacement }] : []
      })
      await this.publish(
        {
          entries: next,
          failed: failed.filter((failure) => !completed.has(failure.marker.sessionId))
        },
        now,
        state.dismissedAt
      )
    })
  }

  /** Settle only this operation's reserved failures; competing reservations remain untouched. */
  failResume(
    operationId: string,
    failures: readonly AgentSessionResumeFailureInput[],
    now: number
  ): Promise<void> {
    return this.withLock(async () => {
      const bySession = new Map(failures.map((failure) => [failure.sessionId, failure]))
      const state = await this.readState()
      const { entries, failed } = normalizeState(state, now)
      const filed = new Map<string, AgentSessionResumeFailureRecord>()
      const next = entries.flatMap((entry) => {
        const failure = this.owns(entry, operationId)
          ? bySession.get(entry.marker.sessionId)
          : undefined
        if (!failure) {
          return [entry]
        }
        const { sessionId, ...record } = failure
        filed.set(sessionId, {
          ...record,
          marker: entry.marker,
          reason: record.reason.slice(0, MAX_FAILURE_FIELD_LENGTH),
          latestPrompt: record.latestPrompt.slice(0, MAX_FAILURE_FIELD_LENGTH)
        })
        // Newer teardown witnesses supersede action-failure verdicts.
        return entry.replacement ? [{ state: 'pending' as const, marker: entry.replacement }] : []
      })
      await this.publish(
        {
          entries: next,
          failed: [
            ...failed.filter((failure) => !filed.has(failure.marker.sessionId)),
            ...filed.values()
          ]
        },
        now,
        state.dismissedAt
      )
    })
  }

  /** Dismiss selected/all records without fencing later teardown offers; clearAll provides that fence. */
  dismiss(
    sessionIds: readonly string[] | 'all',
    now: number,
    /** Evaluate preserved records under the lock against their stored markers. */
    keep: (marker: AgentSessionResumeMarker) => boolean = () => false
  ): Promise<number> {
    return this.withLock(async () => {
      const named = sessionIds === 'all' ? null : new Set(sessionIds)
      const state = await this.readState()
      const { entries, failed } = normalizeState(state, now)
      const dismissed = new Set(
        [...entries, ...failed]
          .filter(({ marker }) => (named?.has(marker.sessionId) ?? true) && !keep(marker))
          .map((record) => record.marker.sessionId)
      )
      if (dismissed.size > 0) {
        await this.publish(
          {
            entries: entries.filter((entry) => !dismissed.has(entry.marker.sessionId)),
            failed: failed.filter((failure) => !dismissed.has(failure.marker.sessionId))
          },
          now,
          state.dismissedAt
        )
      }
      return dismissed.size
    })
  }

  /** New user messages remove only the observed witness (and failedAt for failures), preserving concurrently newer records. */
  forgetSuperseded(
    superseded: readonly { sessionId: string; recordedAt: number; failedAt?: number }[],
    now: number
  ): Promise<void> {
    return this.withLock(async () => {
      const state = await this.readState()
      const { entries, failed } = normalizeState(state, now)
      const keptEntries = entries.filter(
        (entry) =>
          entry.state !== 'pending' ||
          !superseded.some(
            (gone) =>
              gone.failedAt === undefined &&
              gone.sessionId === entry.marker.sessionId &&
              gone.recordedAt === entry.marker.recordedAt
          )
      )
      const keptFailures = failed.filter(
        (failure) =>
          !superseded.some(
            (gone) =>
              gone.sessionId === failure.marker.sessionId && gone.failedAt === failure.failedAt
          )
      )
      if (keptEntries.length !== entries.length || keptFailures.length !== failed.length) {
        await this.publish({ entries: keptEntries, failed: keptFailures }, now, state.dismissedAt)
      }
    })
  }

  rollbackResume(operationId: string, now: number): Promise<void> {
    return this.withLock(async () => {
      const state = await this.readState()
      const { entries, failed } = normalizeState(state, now)
      const next = entries.map((entry): RecoveryEntry =>
        this.owns(entry, operationId)
          ? { state: 'pending', marker: entry.replacement ?? entry.marker }
          : entry
      )
      // Normalize rollback to retain settled failures instead of recreating pending offers.
      await this.publish({ entries: next, failed }, now, state.dismissedAt)
    })
  }

  /** Preserve records unreadable to this host for a compatible Orca. */
  clearAll(now: number, keep: KeepRecord = () => false): Promise<number> {
    return this.withLock(async () => {
      let state: Pick<RecoveryCapsuleState, 'entries' | 'failed'>
      try {
        state = normalizeState(await this.readState(), now)
      } catch {
        // Explicit dismiss may replace unreadable advisory data; fence it against late teardown resurrection.
        await this.publish({ entries: [], failed: [] }, now, now)
        return 0
      }
      const { kept, dismissedPending } = splitDismissedAll(state, keep)
      // Fence every dismissed record; in-flight completion/rollback then cannot resurrect it.
      await this.publish(kept, now, now)
      return dismissedPending
    })
  }

  private async withLock<T>(apply: () => Promise<T>): Promise<T> {
    const previous = capsuleTransactions.get(this.filePath) ?? Promise.resolve()
    const transaction = previous
      .catch(() => {})
      .then(() => withFileTransactionLock(this.filePath, apply))
    capsuleTransactions.set(this.filePath, transaction)
    try {
      return await transaction
    } finally {
      if (capsuleTransactions.get(this.filePath) === transaction) {
        capsuleTransactions.delete(this.filePath)
      }
    }
  }

  private owns(entry: RecoveryEntry, operationId: string): boolean {
    return entry.state === 'in-progress' && entry.operationId === operationId
  }

  private readState = () => readRecoveryCapsule(this.filePath)
  private publish = (records: StoredRecords, now: number, dismissedAt: number | undefined) =>
    publishRecoveryCapsule(this.filePath, records, now, dismissedAt)
}
