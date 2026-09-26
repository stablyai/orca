import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSessionResumeMarker } from '../../shared/agent-session-resume-marker'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  renameDurable,
  writeTempFileDurable
} from '../durable-file-write'
import { withFileTransactionLock } from '../file-transaction-lock'
import {
  MAX_FAILURE_FIELD_LENGTH,
  markerWithContinuation,
  normalizeState,
  parseState,
  shouldReplaceMarker,
  type AgentSessionResumeFailureInput,
  type AgentSessionResumeFailureRecord,
  type RecoveryCapsuleState,
  type RecoveryEntry
} from './agent-session-recovery-capsule-entries'

export type {
  AgentSessionResumeFailureInput,
  AgentSessionResumeFailureRecord
} from './agent-session-recovery-capsule-entries'

export const AGENT_SESSION_RECOVERY_CAPSULE_FILE = 'agent-session-recovery.json'
const MAX_CAPSULE_BYTES = 4 * 1024 * 1024

/** Crash-leftover temp files only; offers themselves have no expiry. */
const STALE_WRITE_TEMP_FILE_AGE_MS = 24 * 60 * 60 * 1000

type StoredRecords = Pick<RecoveryCapsuleState, 'entries' | 'failed'>

/** Durable, per-session restart offers. Listing never spends an offer. */
export class AgentSessionRecoveryCapsule {
  private readonly filePath: string

  constructor(stateDirectory: string) {
    this.filePath = join(stateDirectory, AGENT_SESSION_RECOVERY_CAPSULE_FILE)
  }

  list(now: number): Promise<AgentSessionResumeMarker[]> {
    return withFileTransactionLock(this.filePath, async () => {
      const { entries } = normalizeState(await this.readState(), now)
      return entries.filter((entry) => entry.state === 'pending').map((entry) => entry.marker)
    })
  }

  /** Offers that were acted on and did not end with the agent carrying on. Read-only, like `list`. */
  listFailed(now: number): Promise<AgentSessionResumeFailureRecord[]> {
    return withFileTransactionLock(
      this.filePath,
      async () => normalizeState(await this.readState(), now).failed
    )
  }

  /** Adds fresh teardown witnesses while preserving an action already in progress. */
  record(markers: readonly AgentSessionResumeMarker[], now: number): Promise<void> {
    return withFileTransactionLock(this.filePath, async () => {
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
      // Keep the fence after a newer interruption. It still admits genuinely newer markers,
      // while an older delayed writer remains unable to resurrect a dismissed chat later.
      await this.publish({ entries: [...bySession.values()], failed }, now, dismissedAt)
    })
  }

  /** Reserves only the selected pending sessions for one explicit user action. A recorded failure
   *  is reserved too when the action names it — that is a retry — but never by an unselective
   *  action, which must not re-run what already failed. The failure stays on record until the
   *  retry settles. */
  beginResume(
    sessionIds: readonly string[] | undefined,
    operationId: string,
    now: number,
    /** The continuation this action sends for a marker, recorded on the offer it reserves. */
    continuationFor?: (marker: AgentSessionResumeMarker) => string
  ): Promise<AgentSessionResumeMarker[]> {
    return withFileTransactionLock(this.filePath, async () => {
      const state = await this.readState()
      const { entries, failed } = normalizeState(state, now)
      const requested = sessionIds === undefined ? null : new Set(sessionIds)
      const selected: AgentSessionResumeMarker[] = []
      const reserve = (offer: AgentSessionResumeMarker): RecoveryEntry => {
        const marker = continuationFor
          ? markerWithContinuation(offer, continuationFor(offer))
          : offer
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

  /** The agent carried on: the reservation and any failure it was retrying both go. */
  completeResume(operationId: string, sessionIds: readonly string[], now: number): Promise<void> {
    return withFileTransactionLock(this.filePath, async () => {
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

  /** Records how a reserved session's action ended when the agent did not carry on, replacing any
   *  earlier failure of the same chat. Only rows this operation owns move, so a competing owner's
   *  reservation cannot be settled by proxy. */
  failResume(
    operationId: string,
    failures: readonly AgentSessionResumeFailureInput[],
    now: number
  ): Promise<void> {
    return withFileTransactionLock(this.filePath, async () => {
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
        // A newer teardown seen mid-action is a fresh offer; normalizing drops the stale verdict.
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

  /** Forgets the named sessions whatever their state. Unlike `clearAll`, this is not a fence: a
   *  later teardown of the same chat may record a fresh offer. */
  dismiss(sessionIds: readonly string[], now: number): Promise<number> {
    return withFileTransactionLock(this.filePath, async () => {
      const named = new Set(sessionIds)
      const state = await this.readState()
      const { entries, failed } = normalizeState(state, now)
      const dismissed = new Set(
        [...entries, ...failed]
          .map((record) => record.marker.sessionId)
          .filter((sessionId) => named.has(sessionId))
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

  /** Drops records the chat itself has since superseded — the user's own newer message ends both a
   *  pending offer and a recorded failure. Witness-keyed (`recordedAt`, and `failedAt` for a
   *  failure) so a fresh record written after the caller read the stale one is kept. */
  forgetSuperseded(
    superseded: readonly { sessionId: string; recordedAt: number; failedAt?: number }[],
    now: number
  ): Promise<void> {
    return withFileTransactionLock(this.filePath, async () => {
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
    return withFileTransactionLock(this.filePath, async () => {
      const state = await this.readState()
      const { entries, failed } = normalizeState(state, now)
      const next = entries.map((entry): RecoveryEntry =>
        this.owns(entry, operationId)
          ? { state: 'pending', marker: entry.replacement ?? entry.marker }
          : entry
      )
      // Normalizing on publish keeps a rolled-back retry a failure rather than a pending offer.
      await this.publish({ entries: next, failed }, now, state.dismissedAt)
    })
  }

  clearAll(now: number): Promise<number> {
    return withFileTransactionLock(this.filePath, async () => {
      let entries: RecoveryEntry[]
      try {
        entries = normalizeState(await this.readState(), now).entries
      } catch {
        // Dismiss is an explicit request to forget this advisory file. Replace unreadable bytes
        // with an empty, fenced capsule so a late teardown writer cannot resurrect the offer.
        await this.publish({ entries: [], failed: [] }, now, now)
        return 0
      }
      const pending = entries.filter((entry) => entry.state === 'pending')
      // Dismiss is the explicit user request to forget every recovery record. An in-flight
      // action may still finish, but its later complete/rollback becomes a no-op and cannot
      // resurrect a row the user dismissed.
      await this.publish({ entries: [], failed: [] }, now, now)
      return pending.length
    })
  }

  private owns(entry: RecoveryEntry, operationId: string): boolean {
    return entry.state === 'in-progress' && entry.operationId === operationId
  }

  private async readState(): Promise<RecoveryCapsuleState> {
    let raw: string
    try {
      raw = (await readNodeFileWithinLimit(this.filePath, MAX_CAPSULE_BYTES)).buffer.toString(
        'utf8'
      )
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { entries: [], failed: [] }
      }
      throw error
    }
    return parseState(raw)
  }

  private async publish(
    records: StoredRecords,
    now: number,
    dismissedAt: number | undefined
  ): Promise<void> {
    const { entries, failed } = normalizeState(records, now)
    const { serialized } = stringifyJsonWithinByteLimit(
      {
        version: 2,
        entries,
        ...(dismissedAt === undefined ? {} : { dismissedAt }),
        ...(failed.length === 0 ? {} : { failed })
      },
      MAX_CAPSULE_BYTES
    )
    await removeStaleDurableWriteTempFiles(this.filePath, {
      minimumAgeMs: STALE_WRITE_TEMP_FILE_AGE_MS
    })
    const tempPath = durableWriteTempPath(this.filePath)
    try {
      await writeTempFileDurable(tempPath, serialized, 0o600)
      await renameDurable(tempPath, this.filePath)
    } finally {
      await rm(tempPath, { force: true }).catch(() => {})
    }
  }
}
