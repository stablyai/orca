import type { AgentStatus } from '../../shared/agent-detection'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'

/**
 * The source a chunk/fact was actually observed from: the PTY id the provider
 * delivered under, plus the emitting Session incarnation when the execution
 * host proved one. Absence stays absence — an omitted incarnation is never
 * relabelled from a later control reply.
 */
export type PtyObservationSource = {
  ptyId: string
  incarnationId?: PtyIncarnationId
}

/** Capsule key for a stream whose host could not prove an emitting incarnation. */
export const UNKNOWN_PTY_OBSERVATION_SOURCE_KEY = '\u0000unknown-incarnation'

export function ptyObservationSourceKey(incarnationId?: PtyIncarnationId): string {
  return incarnationId === undefined
    ? UNKNOWN_PTY_OBSERVATION_SOURCE_KEY
    : `id\u0000${incarnationId}`
}

/**
 * Ingestion ordinal plus intra-chunk order. Output sequence alone cannot order
 * observations: salvaged query copies carry zero sequence weight, so two
 * observations can share one sequence value.
 */
export type PtyObservationStamp = {
  ingestionOrdinal: number
  chunkOrder: number
  observedAtEpochMs: number
}

export function isNewerPtyObservationStamp(
  candidate: PtyObservationStamp,
  existing: PtyObservationStamp | null
): boolean {
  if (!existing) {
    return true
  }
  return candidate.ingestionOrdinal === existing.ingestionOrdinal
    ? candidate.chunkOrder >= existing.chunkOrder
    : candidate.ingestionOrdinal > existing.ingestionOrdinal
}

/**
 * Compact outcome of the candidate's latest meaningful lifecycle evidence.
 * `command-finished` records that a foreground command ended — never that the
 * shell took over or that the process exited.
 */
export type PtyObservationLifecycleOutcome =
  | { kind: 'agent-status'; status: AgentStatus | null }
  | { kind: 'command-finished'; exitCode: number | null }

type StampedPtyObservation<T> = { value: T; stamp: PtyObservationStamp }

/**
 * Latest stamped evidence only. Deliberately not an event journal: repeated
 * output replaces fields in place so a long unadmitted wait cannot grow memory.
 */
/** `identityOnly` mirrors the live path's bare cursor-agent literal: it names the pane without asserting activity. */
export type PtyObservationTitle = {
  rawTitle: string
  normalizedTitle: string
  identityOnly: boolean
}

export type PendingPtyObservationSummary = {
  title: StampedPtyObservation<PtyObservationTitle> | null
  explicitStatus: StampedPtyObservation<ParsedAgentStatusPayload> | null
  cwd: StampedPtyObservation<string> | null
  lifecycle: StampedPtyObservation<PtyObservationLifecycleOutcome> | null
  /** Evidence refused for exceeding a payload bound, so promotion can stay conservative. */
  rejectedOversizedObservations: number
}

/** Bounds are rejection thresholds: truncating would reclassify the evidence. */
export const MAX_PTY_OBSERVATION_TITLE_CHARS = 2048
export const MAX_PTY_OBSERVATION_CWD_CHARS = 4096
export const MAX_PTY_OBSERVATION_STATUS_PAYLOAD_CHARS = 8192

/**
 * Audited whole-operation candidate bound for one PTY id.
 *
 * `DaemonPtySessionSpawn.spawn` wraps `doSpawn` in `withDaemonRetry`, which
 * runs it at most twice. Each `doSpawn` transmits at most two `createOrAttach`
 * requests that can create or attach a Session: the initial one and
 * `finishSpawn`'s kill+recreate history retry. The `NdjsonLineTooLongError`
 * inline-seed fallback throws inside `encodeNdjson` before `socket.write`, so
 * it adds no emitting Session incarnation. 2 x 2 = 4.
 */
export const MAX_PENDING_PTY_OBSERVATION_SOURCES = 4

/** Overflow signal: refuses admission before any binding mutation. */
export class PtyObservationCapacityError extends Error {
  constructor(readonly ptyId: string) {
    super('pty_observation_capacity_exceeded')
    this.name = 'PtyObservationCapacityError'
  }
}

export function createPendingPtyObservationSummary(): PendingPtyObservationSummary {
  return {
    title: null,
    explicitStatus: null,
    cwd: null,
    lifecycle: null,
    rejectedOversizedObservations: 0
  }
}

export function recordPtyObservationTitle(
  summary: PendingPtyObservationSummary,
  title: PtyObservationTitle,
  stamp: PtyObservationStamp
): boolean {
  if (
    title.rawTitle.length > MAX_PTY_OBSERVATION_TITLE_CHARS ||
    title.normalizedTitle.length > MAX_PTY_OBSERVATION_TITLE_CHARS
  ) {
    summary.rejectedOversizedObservations += 1
    return false
  }
  if (!isNewerPtyObservationStamp(stamp, summary.title?.stamp ?? null)) {
    return false
  }
  summary.title = { value: { ...title }, stamp }
  return true
}

export function recordPtyObservationExplicitStatus(
  summary: PendingPtyObservationSummary,
  payload: ParsedAgentStatusPayload,
  stamp: PtyObservationStamp
): boolean {
  if (JSON.stringify(payload).length > MAX_PTY_OBSERVATION_STATUS_PAYLOAD_CHARS) {
    summary.rejectedOversizedObservations += 1
    return false
  }
  if (!isNewerPtyObservationStamp(stamp, summary.explicitStatus?.stamp ?? null)) {
    return false
  }
  summary.explicitStatus = { value: payload, stamp }
  return true
}

export function recordPtyObservationCwd(
  summary: PendingPtyObservationSummary,
  cwd: string,
  stamp: PtyObservationStamp
): boolean {
  if (cwd.length > MAX_PTY_OBSERVATION_CWD_CHARS) {
    summary.rejectedOversizedObservations += 1
    return false
  }
  if (!isNewerPtyObservationStamp(stamp, summary.cwd?.stamp ?? null)) {
    return false
  }
  summary.cwd = { value: cwd, stamp }
  return true
}

export function recordPtyObservationLifecycle(
  summary: PendingPtyObservationSummary,
  outcome: PtyObservationLifecycleOutcome,
  stamp: PtyObservationStamp
): boolean {
  if (!isNewerPtyObservationStamp(stamp, summary.lifecycle?.stamp ?? null)) {
    return false
  }
  summary.lifecycle = { value: outcome, stamp }
  return true
}

/** True when the candidate observed nothing an admission could apply. */
export function pendingPtyObservationSummaryIsEmpty(
  summary: PendingPtyObservationSummary
): boolean {
  return (
    summary.title === null &&
    summary.explicitStatus === null &&
    summary.cwd === null &&
    summary.lifecycle === null
  )
}
