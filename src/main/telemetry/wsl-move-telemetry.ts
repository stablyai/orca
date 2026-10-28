/**
 * Migration-outcome telemetry for a WSL move: started, then finished, reset, refused or
 * waiting for its host, with the phase it reached, a reason code and duration and size buckets.
 * Every raw code is narrowed onto the schema's enums here; nothing a user or host named leaves.
 */
import type { EventProps } from '../../shared/telemetry-events'
import {
  WSL_MOVE_REFUSAL_VALUES,
  WSL_MOVE_RESET_REASON_VALUES
} from '../../shared/telemetry-wsl-move-event-schemas'
import type { WslMoveRefusalCode, WslMoveResult } from '../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveCutoverPhase } from '../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveDriverDeps } from '../persistence/moving-wsl-projects/wsl-move-driver-ports'
import { track } from './client'

type Props = EventProps<'wsl_move'>

// Why: a new refusal code must get its own telemetry value, not fall into `other` unnoticed.
type RefusalSuffix = WslMoveRefusalCode extends `wsl_move_${infer Suffix}` ? Suffix : never
type UnlistedRefusal = Exclude<RefusalSuffix, (typeof WSL_MOVE_REFUSAL_VALUES)[number]>
const everyRefusalListed: [UnlistedRefusal] extends [never] ? true : never = true
void everyRefusalListed

function pick<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return values.find((candidate) => candidate === value) ?? fallback
}

function durationBucket(durationMs: number): Props['duration_bucket'] {
  if (durationMs < 5_000) {
    return 'lt_5s'
  }
  if (durationMs < 15_000) {
    return '5s_15s'
  }
  return durationMs < 60_000 ? '15s_60s' : 'gte_60s'
}

function bytesBucket(bytes: number): Props['bytes_bucket'] {
  const mb = 1024 * 1024
  if (bytes <= 0) {
    return '0'
  }
  if (bytes < mb) {
    return 'lt_1mb'
  }
  if (bytes < 10 * mb) {
    return '1mb_10mb'
  }
  return bytes < 100 * mb ? '10mb_100mb' : 'gte_100mb'
}

function phaseValue(phase: WslMoveCutoverPhase | null): Props['phase'] {
  switch (phase) {
    case null:
      return 'none'
    case 'destination-staged':
      return 'destination_staged'
    case 'blobs-transferred':
      return 'blobs_transferred'
    case 'destination-committed':
    case 'client-rewritten':
    case 'retained':
      return 'destination_committed'
    case 'prepared':
    case 'source-fenced':
    case 'quiesced':
      return 'before_stage'
  }
}

// Ordered: the first match names the reason, so specific codes come before generic ones.
const RESET_REASON_PATTERNS: readonly [RegExp, Props['reset_reason']][] = [
  [/orcad_migration_staged_claim_conflict/u, 'staged_claim_conflict'],
  [/orcad_migration_repository_path_conflict/u, 'repository_path_conflict'],
  [/distro_unregistered|wsl_distro_not_registered/u, 'distro_unregistered'],
  [/terminals-started-after-pause/u, 'terminals_started'],
  [/exit-unverifiable/u, 'exit_unverifiable'],
  [/wsl_move_stage_not_staged/u, 'stage_rejected'],
  [/orcad_migration_blob/u, 'blob_rejected'],
  [/wsl_move_commit_not_committed|orcad_migration_catalog_not_staged/u, 'commit_rejected'],
  [/destination_unreachable|ECONNREFUSED|ECONNRESET|EPIPE/u, 'host_unreachable']
]

/** Only the matched code leaves, never the detail text itself. */
export function wslMoveResetReason(detail: string): Props['reset_reason'] {
  const match = RESET_REASON_PATTERNS.find(([pattern]) => pattern.test(detail))
  return pick(WSL_MOVE_RESET_REASON_VALUES, match?.[1] ?? 'other', 'other')
}

export function wslMoveOutcomeProps(
  result: WslMoveResult,
  observed: { phase: WslMoveCutoverPhase | null; bytesTotal: number; durationMs: number }
): Props {
  const base = {
    duration_bucket: durationBucket(observed.durationMs),
    bytes_bucket: bytesBucket(observed.bytesTotal)
  }
  switch (result.outcome) {
    case 'moved':
      return {
        outcome: 'finished',
        refusal: 'none',
        phase: phaseValue(result.phase),
        reset_reason: 'none',
        ...base
      }
    case 'refused':
      return {
        outcome: 'refused',
        refusal: pick(WSL_MOVE_REFUSAL_VALUES, result.code.replace(/^wsl_move_/u, ''), 'other'),
        phase: phaseValue(observed.phase),
        // A pause refusal after a reset carries the reason in its detail.
        reset_reason: result.detail ? wslMoveResetReason(result.detail) : 'none',
        ...base
      }
    case 'reset':
    case 'waiting-for-host':
      return {
        outcome: result.outcome === 'reset' ? 'reset' : 'waiting_for_host',
        refusal: 'none',
        phase: phaseValue(observed.phase),
        reset_reason: wslMoveResetReason(result.detail),
        ...base
      }
  }
}

function safeTrack(props: Props): void {
  try {
    // track() applies the consent gate and validates against the strict schema.
    track('wsl_move', props)
  } catch {
    // Telemetry never costs a move.
  }
}

/** Runs one move with its start and outcome reported; the move's own result is returned as is. */
export async function runTrackedWslMove(
  deps: WslMoveDriverDeps,
  run: (deps: WslMoveDriverDeps) => Promise<WslMoveResult>
): Promise<WslMoveResult> {
  const startedAt = deps.now().getTime()
  const observed: { phase: WslMoveCutoverPhase | null; bytesTotal: number } = {
    phase: null,
    bytesTotal: 0
  }
  const tracked: WslMoveDriverDeps = {
    ...deps,
    progress: (event) => {
      observed.phase = event.phase ?? observed.phase
      observed.bytesTotal = event.bytesTotal ?? observed.bytesTotal
      deps.progress(event)
    }
  }
  safeTrack({
    outcome: 'started',
    refusal: 'none',
    phase: 'none',
    reset_reason: 'none',
    duration_bucket: 'lt_5s',
    bytes_bucket: '0'
  })
  let result: WslMoveResult
  try {
    result = await run(tracked)
  } catch (error) {
    safeTrack({
      outcome: 'reset',
      refusal: 'none',
      phase: phaseValue(observed.phase),
      reset_reason: 'other',
      duration_bucket: durationBucket(Math.max(0, deps.now().getTime() - startedAt)),
      bytes_bucket: bytesBucket(observed.bytesTotal)
    })
    throw error
  }
  safeTrack(
    wslMoveOutcomeProps(result, {
      ...observed,
      durationMs: Math.max(0, deps.now().getTime() - startedAt)
    })
  )
  return result
}
