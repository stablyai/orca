/**
 * Undo telemetry for a WSL move ("use this project here again"): one enum-only row per request
 * that got past the gate, with how it ended and a duration bucket. Nothing a user or host named leaves.
 */
import type { EventProps } from '../../shared/telemetry-events'
import { WSL_MOVE_UNDO_OUTCOME_VALUES } from '../../shared/telemetry-wsl-move-event-schemas'
import type { WslMoveUseLocallyResult } from '../../shared/wsl-move/wsl-moved-project'
import { track } from './client'
import { durationBucket } from './wsl-move-telemetry'

type Props = EventProps<'wsl_move_undo'>

// Why: a new refusal reason must get its own telemetry value, not fall into `other` unnoticed.
type Reason = Exclude<Extract<WslMoveUseLocallyResult, { released: false }>['reason'], 'gated-off'>
type Snake<T extends string> = T extends `${infer Head}-${infer Tail}`
  ? `${Head}_${Snake<Tail>}`
  : T
type Unlisted = Exclude<Snake<Reason>, (typeof WSL_MOVE_UNDO_OUTCOME_VALUES)[number]>
const everyReasonListed: [Unlisted] extends [never] ? true : never = true
void everyReasonListed

export function wslMoveUndoOutcome(result: WslMoveUseLocallyResult): Props['outcome'] {
  if (result.released) {
    return 'released'
  }
  const value = result.reason.replaceAll('-', '_')
  return WSL_MOVE_UNDO_OUTCOME_VALUES.find((candidate) => candidate === value) ?? 'other'
}

/** Runs one undo with its outcome reported; the undo's own result is returned as is. */
export async function runTrackedWslMoveUndo(
  now: () => number,
  run: () => Promise<WslMoveUseLocallyResult>
): Promise<WslMoveUseLocallyResult> {
  const startedAt = now()
  let result: WslMoveUseLocallyResult
  try {
    result = await run()
  } catch (error) {
    safeTrack({ outcome: 'threw', duration_bucket: durationBucket(Math.max(0, now() - startedAt)) })
    throw error
  }
  safeTrack({
    outcome: wslMoveUndoOutcome(result),
    duration_bucket: durationBucket(Math.max(0, now() - startedAt))
  })
  return result
}

function safeTrack(props: Props): void {
  try {
    // track() applies the consent gate and validates against the strict schema.
    track('wsl_move_undo', props)
  } catch {
    // Telemetry never costs an undo.
  }
}
