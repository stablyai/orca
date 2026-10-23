import type { RuntimeWorktreeTerminalSleepResult } from '../../../shared/runtime-types'

/** One RPC to the paired server; rejects with the server's error `code` on a refusal. */
export type RemoteWorkspaceCall = (
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<unknown>

type RemoteTerminalListResult = {
  terminals: {
    connected: boolean
    ptyId: string | null
  }[]
  totalCount: number
  truncated: boolean
}

const LEGACY_SLEEP_VERIFY_ATTEMPTS = 8
const LEGACY_SLEEP_VERIFY_INTERVAL_MS = 250
const LEGACY_SLEEP_TIMEOUT_MS = 15_000
const LEGACY_SLEEP_RPC_TIMEOUT_MS = 5_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

export function assertVerifiedSleepResult(
  value: unknown
): asserts value is RuntimeWorktreeTerminalSleepResult & { postStopVerified: true } {
  if (
    !isRecord(value) ||
    typeof value.stopped !== 'number' ||
    !Number.isInteger(value.stopped) ||
    value.stopped < 0 ||
    !isStringArray(value.stoppedPtyIds) ||
    !isStringArray(value.livePtyIds)
  ) {
    throw new Error('terminal_worktree_sleep_invalid_response')
  }
  if (value.postStopVerified === true) {
    if (value.postStopFailure !== undefined || value.remainingLivePtyIds !== undefined) {
      throw new Error('terminal_worktree_sleep_invalid_response')
    }
    return
  }
  const failure = value.postStopFailure
  if (failure === 'terminal_worktree_sleep_still_live') {
    if (!isStringArray(value.remainingLivePtyIds)) {
      throw new Error('terminal_worktree_sleep_invalid_response')
    }
    throw Object.assign(new Error(failure), {
      remainingLivePtyIds: value.remainingLivePtyIds
    })
  }
  if (failure === 'terminal_liveness_unavailable' && value.remainingLivePtyIds === undefined) {
    throw new Error(failure)
  }
  throw new Error('terminal_worktree_sleep_unverified')
}

function hasLiveListedTerminal(value: unknown): boolean | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.terminals) ||
    !Number.isInteger(value.totalCount) ||
    (value.totalCount as number) < 0 ||
    typeof value.truncated !== 'boolean' ||
    value.truncated ||
    value.totalCount !== value.terminals.length
  ) {
    return null
  }
  for (const terminal of value.terminals as NonNullable<RemoteTerminalListResult['terminals']>) {
    if (
      !isRecord(terminal) ||
      typeof terminal.connected !== 'boolean' ||
      (typeof terminal.ptyId !== 'string' && terminal.ptyId !== null)
    ) {
      return null
    }
    // Why: old runtimes retain disconnected/null renderer placeholders; only a connected physical PTY proves liveness.
    if (terminal.connected === true && typeof terminal.ptyId === 'string' && terminal.ptyId) {
      return true
    }
  }
  return false
}

async function waitForLegacySleepConvergence(
  call: RemoteWorkspaceCall,
  worktreeSelector: string,
  deadline: number
): Promise<void> {
  let lastFailure: unknown = null
  for (let attempt = 0; attempt < LEGACY_SLEEP_VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const delayMs = Math.min(LEGACY_SLEEP_VERIFY_INTERVAL_MS, deadline - Date.now())
      if (delayMs <= 0) {
        break
      }
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs))
    }
    try {
      const listTimeoutMs = legacySleepRpcTimeout(deadline)
      const result = await call(
        'terminal.list',
        {
          worktree: worktreeSelector,
          limit: 10_000,
          requireFreshPtyLiveness: true,
          includeVisualLayouts: false
        },
        listTimeoutMs
      )
      const hasLiveTerminal = hasLiveListedTerminal(result)
      if (hasLiveTerminal === false) {
        return
      }
      if (hasLiveTerminal === true) {
        // Why: a fresh legacy list can hydrate a PTY the first graph-based stop did not know about; stop again after discovery.
        await call('terminal.stop', { worktree: worktreeSelector }, legacySleepRpcTimeout(deadline))
        lastFailure = null
      } else {
        lastFailure = new Error('terminal_list_invalid_response')
      }
    } catch (error) {
      lastFailure = error
    }
  }
  const error = new Error('terminal_worktree_sleep_legacy_unverified')
  throw lastFailure ? Object.assign(error, { cause: lastFailure }) : error
}

function legacySleepRpcTimeout(
  deadline: number,
  maxTimeoutMs = LEGACY_SLEEP_RPC_TIMEOUT_MS
): number {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    throw new Error('terminal_worktree_sleep_legacy_timeout')
  }
  return Math.min(maxTimeoutMs, remainingMs)
}

/** A paired server's terminal sleep, verified; an older server without `terminal.sleep` is stopped
 *  and polled until no terminal is live. Returns the server's own PTY handles it stopped. */
export async function requestRemoteWorktreeSleep(
  call: RemoteWorkspaceCall,
  worktreeId: string
): Promise<string[]> {
  const worktreeSelector = `id:${worktreeId}`
  try {
    const result = await call('terminal.sleep', { worktree: worktreeSelector }, 15_000)
    assertVerifiedSleepResult(result)
    return result.stoppedPtyIds
  } catch (error) {
    if (!isRecord(error) || error.code !== 'method_not_found') {
      throw error
    }
  }

  // Why: previous runtimes lack host-authoritative discover/stop/verify; fresh polling prevents legacy stop acknowledgement from becoming a false sleeping commit.
  const legacyDeadline = Date.now() + LEGACY_SLEEP_TIMEOUT_MS
  await call(
    'terminal.stop',
    { worktree: worktreeSelector },
    legacySleepRpcTimeout(legacyDeadline, LEGACY_SLEEP_TIMEOUT_MS)
  )
  await waitForLegacySleepConvergence(call, worktreeSelector, legacyDeadline)
  return []
}
