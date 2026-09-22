import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  AGENT_SESSION_RESUME_MARKER_TTL_MS,
  isExpiredAgentSessionResumeMarker,
  parseAgentSessionResumeMarker,
  type AgentSessionResumeMarker
} from '../../shared/agent-session-resume-marker'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  renameDurable,
  writeTempFileDurable
} from '../durable-file-write'
import { withFileTransactionLock } from '../file-transaction-lock'

export const AGENT_SESSION_RECOVERY_CAPSULE_FILE = 'agent-session-recovery.json'
const MAX_CAPSULE_BYTES = 4 * 1024 * 1024
const RESUME_ACTION_LEASE_TTL_MS = 10 * 60 * 1000

const legacyCapsuleSchema = z.object({ version: z.literal(1), markers: z.array(z.unknown()) })
const entrySchema = z.object({
  state: z.enum(['pending', 'in-progress']),
  operationId: z.string().min(1).optional(),
  startedAt: z.number().int().nonnegative().optional(),
  marker: z.unknown(),
  replacement: z.unknown().optional()
})
const capsuleSchema = z.object({
  version: z.literal(2),
  entries: z.array(z.unknown()),
  dismissedAt: z.number().int().nonnegative().optional()
})

type RecoveryEntry = {
  state: 'pending' | 'in-progress'
  operationId?: string
  startedAt?: number
  marker: AgentSessionResumeMarker
  replacement?: AgentSessionResumeMarker
}

type RecoveryCapsuleState = {
  entries: RecoveryEntry[]
  dismissedAt?: number
}

function parseMarker(value: unknown): AgentSessionResumeMarker {
  const marker = parseAgentSessionResumeMarker(value)
  if (!marker) {
    throw new Error('agent_session_recovery_capsule_invalid')
  }
  return marker
}

function parseState(raw: string): RecoveryCapsuleState {
  const value: unknown = JSON.parse(raw)
  const legacy = legacyCapsuleSchema.safeParse(value)
  if (legacy.success) {
    return {
      entries: legacy.data.markers.map((marker) => ({
        state: 'pending',
        marker: parseMarker(marker)
      }))
    }
  }
  const capsule = capsuleSchema.parse(value)
  const entries = capsule.entries.map((entry) => {
    const parsed = entrySchema.parse(entry)
    const marker = parseMarker(parsed.marker)
    const replacement =
      parsed.replacement === undefined ? undefined : parseMarker(parsed.replacement)
    if (replacement && replacement.sessionId !== marker.sessionId) {
      throw new Error('agent_session_recovery_capsule_invalid')
    }
    if (parsed.state === 'pending') {
      return { state: 'pending' as const, marker, ...(replacement ? { replacement } : {}) }
    }
    if (parsed.operationId === undefined || parsed.startedAt === undefined) {
      throw new Error('agent_session_recovery_capsule_invalid')
    }
    return {
      state: 'in-progress' as const,
      operationId: parsed.operationId,
      startedAt: parsed.startedAt,
      marker,
      ...(replacement ? { replacement } : {})
    }
  })
  return {
    entries,
    ...(capsule.dismissedAt === undefined ? {} : { dismissedAt: capsule.dismissedAt })
  }
}

function normalizeEntries(entries: readonly RecoveryEntry[], now: number): RecoveryEntry[] {
  const bySession = new Map<string, RecoveryEntry>()
  for (const entry of entries) {
    const replacement =
      entry.replacement && !isExpiredAgentSessionResumeMarker(entry.replacement, now)
        ? entry.replacement
        : undefined
    if (isExpiredAgentSessionResumeMarker(entry.marker, now) && replacement === undefined) {
      continue
    }
    if (bySession.has(entry.marker.sessionId)) {
      throw new Error('agent_session_recovery_capsule_duplicate_session')
    }
    const reclaimed =
      entry.state === 'in-progress' &&
      entry.startedAt !== undefined &&
      now - entry.startedAt > RESUME_ACTION_LEASE_TTL_MS
    const normalized: RecoveryEntry =
      entry.state === 'in-progress' && reclaimed
        ? { state: 'pending', marker: replacement ?? entry.marker }
        : entry.state === 'pending' && replacement
          ? { state: 'pending', marker: replacement }
          : replacement
            ? { ...entry, replacement }
            : entry
    bySession.set(normalized.marker.sessionId, normalized)
  }
  return [...bySession.values()]
}

function shouldReplaceMarker(
  current: AgentSessionResumeMarker,
  incoming: AgentSessionResumeMarker
): boolean {
  if (incoming.recordedAt !== current.recordedAt) {
    return incoming.recordedAt > current.recordedAt
  }
  // A single teardown may publish the same witness more than once. Different teardown IDs at the
  // same clock value have no ordering signal, so keep the first one rather than let a late writer
  // regress a newer witness from another host.
  return incoming.teardownId === current.teardownId
}

/** Durable, per-session restart offers. Listing never spends an offer. */
export class AgentSessionRecoveryCapsule {
  private readonly filePath: string

  constructor(stateDirectory: string) {
    this.filePath = join(stateDirectory, AGENT_SESSION_RECOVERY_CAPSULE_FILE)
  }

  list(now: number): Promise<AgentSessionResumeMarker[]> {
    return withFileTransactionLock(this.filePath, async () => {
      const entries = normalizeEntries((await this.readState()).entries, now)
      return entries.filter((entry) => entry.state === 'pending').map((entry) => entry.marker)
    })
  }

  /** Adds fresh teardown witnesses while preserving an action already in progress. */
  record(markers: readonly AgentSessionResumeMarker[], now: number): Promise<void> {
    return withFileTransactionLock(this.filePath, async () => {
      const state = await this.readState()
      const entries = normalizeEntries(state.entries, now)
      const bySession = new Map(entries.map((entry) => [entry.marker.sessionId, entry]))
      const dismissedAt = state.dismissedAt
      for (const marker of markers) {
        if (
          isExpiredAgentSessionResumeMarker(marker, now) ||
          (dismissedAt !== undefined && marker.recordedAt <= dismissedAt)
        ) {
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
        if (existing && !shouldReplaceMarker(existing.marker, marker)) {
          continue
        }
        bySession.set(marker.sessionId, { state: 'pending', marker })
      }
      // Keep the fence after a newer interruption. It still admits genuinely newer markers,
      // while an older delayed writer remains unable to resurrect a dismissed chat later.
      await this.publish([...bySession.values()], dismissedAt)
    })
  }

  /** Reserves only the selected pending sessions for one explicit user action. */
  beginResume(
    sessionIds: readonly string[] | undefined,
    operationId: string,
    now: number
  ): Promise<AgentSessionResumeMarker[]> {
    return withFileTransactionLock(this.filePath, async () => {
      const state = await this.readState()
      const entries = normalizeEntries(state.entries, now)
      const requested = sessionIds === undefined ? null : new Set(sessionIds)
      const selected: AgentSessionResumeMarker[] = []
      const next = entries.map((entry) => {
        if (
          entry.state !== 'pending' ||
          (requested !== null && !requested.has(entry.marker.sessionId))
        ) {
          return entry
        }
        selected.push(entry.marker)
        return { state: 'in-progress' as const, operationId, startedAt: now, marker: entry.marker }
      })
      await this.publish(next, state.dismissedAt)
      return selected
    })
  }

  completeResume(operationId: string, sessionIds: readonly string[], now: number): Promise<void> {
    return withFileTransactionLock(this.filePath, async () => {
      const selected = new Set(sessionIds)
      const state = await this.readState()
      const entries = normalizeEntries(state.entries, now).flatMap((entry) => {
        if (
          entry.state !== 'in-progress' ||
          entry.operationId !== operationId ||
          !selected.has(entry.marker.sessionId)
        ) {
          return [entry]
        }
        return entry.replacement ? [{ state: 'pending' as const, marker: entry.replacement }] : []
      })
      await this.publish(entries, state.dismissedAt)
    })
  }

  rollbackResume(operationId: string, now: number): Promise<void> {
    return withFileTransactionLock(this.filePath, async () => {
      const state = await this.readState()
      const entries = normalizeEntries(state.entries, now).flatMap((entry) => {
        if (entry.state !== 'in-progress' || entry.operationId !== operationId) {
          return [entry]
        }
        return [{ state: 'pending' as const, marker: entry.replacement ?? entry.marker }]
      })
      await this.publish(entries, state.dismissedAt)
    })
  }

  clearAll(now: number): Promise<number> {
    return withFileTransactionLock(this.filePath, async () => {
      let entries: RecoveryEntry[]
      try {
        entries = normalizeEntries((await this.readState()).entries, now)
      } catch {
        // Dismiss is an explicit request to forget this advisory file. Replace unreadable bytes
        // with an empty, fenced capsule so a late teardown writer cannot resurrect the offer.
        await this.publish([], now)
        return 0
      }
      const pending = entries.filter((entry) => entry.state === 'pending')
      // Dismiss is the explicit user request to forget every recovery record. An in-flight
      // action may still finish, but its later complete/rollback becomes a no-op and cannot
      // resurrect a row the user dismissed.
      await this.publish([], now)
      return pending.length
    })
  }

  private async readState(): Promise<RecoveryCapsuleState> {
    let raw: string
    try {
      raw = (await readNodeFileWithinLimit(this.filePath, MAX_CAPSULE_BYTES)).buffer.toString(
        'utf8'
      )
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { entries: [] }
      }
      throw error
    }
    return parseState(raw)
  }

  private async publish(entries: readonly RecoveryEntry[], dismissedAt?: number): Promise<void> {
    const { serialized } = stringifyJsonWithinByteLimit(
      { version: 2, entries, ...(dismissedAt === undefined ? {} : { dismissedAt }) },
      MAX_CAPSULE_BYTES
    )
    await removeStaleDurableWriteTempFiles(this.filePath, {
      minimumAgeMs: AGENT_SESSION_RESUME_MARKER_TTL_MS
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
