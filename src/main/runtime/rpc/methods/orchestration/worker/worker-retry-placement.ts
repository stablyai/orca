import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from './worker-start-schema'

const RETRY_PLACEMENT_REQUIRED =
  '--retry-of does not inherit placement. Pass --worktree <selector> or --terminal <handle>.'

type RetryPlacementStore = {
  getWorkerDispatch(dispatchId: string): { start_options: string } | undefined
}

type PriorRetryPlacement = {
  worktree?: string
  resolvedWorktreeId?: string
  terminal?: string
}

// Why: omitted retry placement used to fall through to the coordinator's `current` worktree.
export function assertRetryOfRepeatsPlacement(
  params: Pick<WorkerStartInput, 'retryOf' | 'worktree' | 'terminal'>,
  db: RetryPlacementStore
): void {
  if (!params.retryOf || params.worktree || params.terminal) {
    return
  }
  const prior = readPriorRetryPlacement(db.getWorkerDispatch(params.retryOf)?.start_options)
  throw new OrchestrationError('invalid_argument', formatRetryPlacementRefusal(prior))
}

function formatRetryPlacementRefusal(prior: PriorRetryPlacement | undefined): string {
  const used = formatPriorRetryPlacement(prior)
  return used ? `${RETRY_PLACEMENT_REQUIRED} Prior attempt used ${used}.` : RETRY_PLACEMENT_REQUIRED
}

function formatPriorRetryPlacement(prior: PriorRetryPlacement | undefined): string | undefined {
  if (!prior) {
    return undefined
  }
  const parts: string[] = []
  if (prior.resolvedWorktreeId) {
    const selector = prior.resolvedWorktreeId.startsWith('id:')
      ? prior.resolvedWorktreeId
      : `id:${prior.resolvedWorktreeId}`
    parts.push(`--worktree ${selector}`)
  } else if (prior.worktree) {
    parts.push(`--worktree ${prior.worktree}`)
  }
  if (prior.terminal) {
    parts.push(`--terminal ${prior.terminal}`)
  }
  return parts.length > 0 ? parts.join(' and ') : undefined
}

function readPriorRetryPlacement(
  startOptionsJson: string | undefined
): PriorRetryPlacement | undefined {
  if (!startOptionsJson) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(startOptionsJson)
    const worktree = readRecordString(parsed, 'worktree')
    const resolvedWorktreeId = readRecordString(parsed, 'resolvedWorktreeId')
    const terminal = readRecordString(parsed, 'terminal')
    if (!worktree && !resolvedWorktreeId && !terminal) {
      return undefined
    }
    return { worktree, resolvedWorktreeId, terminal }
  } catch {
    return undefined
  }
}

function readRecordString(value: unknown, key: string): string | undefined {
  if (!isJsonRecord(value)) {
    return undefined
  }
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
