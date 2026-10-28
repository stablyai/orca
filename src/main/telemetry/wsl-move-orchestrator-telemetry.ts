/**
 * The move orchestrator's telemetry (D3a): one enum-only row each time a distro's state changes,
 * so the rollout can see how many moves wait on busy terminals, back off or park, and why.
 */
import type { EventProps } from '../../shared/telemetry-events'
import { WSL_MOVE_REFUSAL_VALUES } from '../../shared/telemetry-wsl-move-event-schemas'
import type { WslMovePreview, WslMoveResult } from '../../shared/wsl-move/wsl-move-driver-types'
import type {
  WslMoveOrchestratorParkReason,
  WslMoveOrchestratorRecord,
  WslMoveOrchestratorTrigger
} from '../../shared/wsl-move/wsl-move-orchestrator-types'
import { track } from './client'
import { wslMoveResetReason } from './wsl-move-telemetry'

type Props = EventProps<'wsl_move_orchestrator'>

function transition(record: WslMoveOrchestratorRecord): Props['transition'] {
  switch (record.state.kind) {
    case 'moving':
      return 'started'
    case 'waiting-for-host':
      return 'waiting_for_host'
    case 'distro-gone':
      return 'distro_gone'
    case 'restore-offered':
      return 'restore_offered'
    case 'idle':
    case 'pending':
    case 'deferred':
    case 'backoff':
    case 'parked':
    case 'done':
      return record.state.kind
  }
}

function parkReason(reason: WslMoveOrchestratorParkReason): Props['park_reason'] {
  switch (reason) {
    case 'export-incomplete':
      return 'export_incomplete'
    case 'manifest-too-large':
      return 'manifest_too_large'
    case 'host-update-required':
      return 'host_update_required'
    case 'attempts-exhausted':
      return 'attempts_exhausted'
    case 'not-now':
      return 'not_now'
    case 'declined':
      return 'declined'
    case 'removal-pending':
      return 'removal_pending'
    case 'stuck':
      return 'stuck'
  }
}

function attemptBucket(attempts: number): Props['attempt_bucket'] {
  if (attempts <= 0) {
    return '0'
  }
  if (attempts === 1) {
    return '1'
  }
  return attempts <= 3 ? '2_3' : 'gte_4'
}

export function wslMoveOrchestratorEventProps(
  trigger: WslMoveOrchestratorTrigger,
  record: WslMoveOrchestratorRecord,
  cause?: WslMovePreview | WslMoveResult
): Props {
  const refusal =
    cause?.outcome === 'refused'
      ? (WSL_MOVE_REFUSAL_VALUES.find((value) => value === cause.code.replace(/^wsl_move_/u, '')) ??
        'other')
      : 'none'
  const resetDetail =
    cause?.outcome === 'reset' || cause?.outcome === 'waiting-for-host' ? cause.detail : null
  return {
    trigger: trigger === 'project-opened' ? 'project_opened' : trigger,
    transition: transition(record),
    refusal,
    reset_reason: resetDetail === null ? 'none' : wslMoveResetReason(resetDetail),
    park_reason: record.state.kind === 'parked' ? parkReason(record.state.reason) : 'none',
    attempt_bucket: attemptBucket(record.attempts)
  }
}

export function trackWslMoveOrchestrator(props: Props): void {
  try {
    // track() applies the consent gate and validates against the strict schema.
    track('wsl_move_orchestrator', props)
  } catch {
    // Telemetry never costs a move.
  }
}
