import { RuntimeClientError } from '../runtime-client'
import {
  getMaximumWorktreeCreateTransportTimeoutMs,
  type WorktreeCreateTimeoutOverrides
} from '../../shared/worktree-create-timeouts'

const MIN_WORKTREE_CREATE_TIMEOUT_MS = 1_000
const MAX_WORKTREE_CREATE_TIMEOUT_MS = 7_200_000
type WorktreeCreateTimeoutConfig = {
  timeouts?: WorktreeCreateTimeoutOverrides
  transportTimeoutMs: number
}

function getOptionalWorktreeCreateTimeoutFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const rawValue = flags.get(name)
  const value = typeof rawValue === 'string' ? Number(rawValue) : Number.NaN
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < MIN_WORKTREE_CREATE_TIMEOUT_MS ||
    value > MAX_WORKTREE_CREATE_TIMEOUT_MS
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${name} must be a finite integer between ${MIN_WORKTREE_CREATE_TIMEOUT_MS} and ${MAX_WORKTREE_CREATE_TIMEOUT_MS}`
    )
  }
  return value
}

export function getWorktreeCreateTimeoutConfig(
  flags: Map<string, string | boolean>
): WorktreeCreateTimeoutConfig {
  const refreshBaseRefMs = getOptionalWorktreeCreateTimeoutFlag(flags, 'refresh-timeout-ms')
  const addCheckoutMs = getOptionalWorktreeCreateTimeoutFlag(flags, 'add-timeout-ms')
  const registrationMs = getOptionalWorktreeCreateTimeoutFlag(flags, 'registration-timeout-ms')
  const materializationMs = getOptionalWorktreeCreateTimeoutFlag(
    flags,
    'materialization-timeout-ms'
  )
  const timeouts: WorktreeCreateTimeoutOverrides = {
    ...(refreshBaseRefMs !== undefined ? { refreshBaseRefMs } : {}),
    ...(addCheckoutMs !== undefined ? { addCheckoutMs } : {}),
    ...(registrationMs !== undefined ? { registrationMs } : {}),
    ...(materializationMs !== undefined ? { materializationMs } : {})
  }
  return {
    ...(Object.keys(timeouts).length > 0 ? { timeouts } : {}),
    // Why: old hosts ignore the optional stage fields and create also performs
    // setup outside these four budgets, so a shorter client envelope can
    // disconnect while the host is still completing a valid workspace.
    transportTimeoutMs: getMaximumWorktreeCreateTransportTimeoutMs()
  }
}
