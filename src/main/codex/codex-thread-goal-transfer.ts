import { resolveCodexCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  CodexAppServerCapabilityCache,
  getCodexAppServerHostKey
} from './codex-app-server-capability-cache'
import {
  isCodexAppServerUnsupportedError,
  runCodexAppServerSession,
  type CodexAppServerInvocation
} from './codex-app-server-session'

/**
 * Carries a thread's `/goal` across an account-switch restart.
 *
 * Why only part of it: Codex stores goals in a per-home sqlite DB, so a thread
 * resumed under another account starts with no goal at all. The objective, the
 * budget and the user's own pause/block/complete state are what the user loses
 * and what Codex's own RPCs can restore. Everything the previous account
 * metered stays behind: the usage counters, and the limit statuses derived from
 * them. Hitting a limit is a fact about the account being left, and the account
 * being moved to has its own headroom — which is usually the whole reason for
 * the switch.
 *
 * Orca never touches Codex's sqlite directly; `thread/goal/get` and
 * `thread/goal/set` are the app-server's own surface for this.
 */

// Why so short: the restart awaits this before the PTY exists, so every second
// here is a second the user stares at an empty pane. A goal that does not
// arrive in time is a smaller loss than a terminal that feels hung.
const GOAL_RPC_TIMEOUT_MS = 4_000
const GOAL_TRANSFER_DEADLINE_MS = 6_000

// Why remapped rather than dropped: leaving the status unset would let the new
// account inherit whatever default Codex applies, and an active goal must stay
// active across the move. See #12098 — the limit is what triggered the switch.
//
// Why these exact spellings: the app-server's own enum, not the sqlite column's.
// `thread/goal/set` answers a snake_case status with "unknown variant
// `usage_limited`, expected one of `active`, `paused`, `blocked`, `usageLimited`,
// `budgetLimited`, `complete`" — so the wire names are camelCase even though the
// goals DB stores them with underscores. Both are accepted on the way in, since
// a read that ever returns the DB spelling must still be recognised as a limit.
const ACCOUNT_METERED_GOAL_STATUSES = new Set([
  'usageLimited',
  'budgetLimited',
  'usage_limited',
  'budget_limited'
])
const CODEX_GOAL_STATUSES = new Set([
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete'
])
const GOAL_STATUS_AFTER_ACCOUNT_MOVE = 'active'

// Why dedicated: the shared cache answers for a different method surface, and
// one CLI can expose that one while lacking the goal RPCs.
const goalRpcCapabilityCache = new CodexAppServerCapabilityCache()

export type CodexTransferableThreadGoal = {
  objective: string
  status?: string
  tokenBudget?: number
}

export function parseCodexThreadGoal(value: unknown): CodexTransferableThreadGoal | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const goal = (value as { goal?: unknown }).goal ?? value
  if (!goal || typeof goal !== 'object') {
    return null
  }
  const record = goal as Record<string, unknown>
  const objective = record.objective
  if (typeof objective !== 'string' || objective.trim().length === 0) {
    return null
  }
  const status = resolveGoalStatusAfterAccountMove(record.status)
  const tokenBudget = record.tokenBudget ?? record.token_budget
  return {
    objective,
    ...(status ? { status } : {}),
    ...(typeof tokenBudget === 'number' && Number.isFinite(tokenBudget) ? { tokenBudget } : {})
  }
}

function resolveGoalStatusAfterAccountMove(status: unknown): string | null {
  if (typeof status !== 'string' || status.length === 0) {
    return null
  }
  if (ACCOUNT_METERED_GOAL_STATUSES.has(status)) {
    return GOAL_STATUS_AFTER_ACCOUNT_MOVE
  }
  // Why dropped rather than forwarded: `thread/goal/set` rejects a status it does
  // not know, and that rejection would fail the whole transfer — losing the
  // objective too, over a field the new account can default for itself.
  return CODEX_GOAL_STATUSES.has(status) ? status : null
}

function buildGoalInvocation(codexHomePath: string): CodexAppServerInvocation {
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolveCodexCommand(), ['app-server'])
  return {
    command: spawnCmd,
    args: spawnArgs,
    // Why: the daemon environment can carry another account's CODEX_HOME, which
    // would read or write the wrong account's goals DB.
    env: { CODEX_HOME: codexHomePath },
    timeoutMs: GOAL_RPC_TIMEOUT_MS
  }
}

/**
 * Copies one thread's goal from the origin home into the target home.
 *
 * Best-effort by construction: the restart it accompanies must proceed whether
 * or not this succeeds, so every failure resolves to a reason string instead of
 * throwing. Returns 'transferred' only when the target accepted the goal.
 */
export async function transferCodexThreadGoalBetweenHomes(args: {
  threadId: string
  originCodexHomePath: string
  targetCodexHomePath: string
  nowMs?: number
}): Promise<'transferred' | 'no-goal' | 'unsupported' | 'skipped' | 'failed'> {
  if (
    normalizeRuntimePathForComparison(args.originCodexHomePath) ===
    normalizeRuntimePathForComparison(args.targetCodexHomePath)
  ) {
    return 'skipped'
  }
  // Why native only: an account-switch restart is a host-lane action, and the
  // managed homes it moves between are host homes.
  const hostKey = getCodexAppServerHostKey({ kind: 'native' })
  const nowMs = args.nowMs ?? Date.now()
  if (
    !goalRpcCapabilityCache.isKnownSupported(hostKey) &&
    !goalRpcCapabilityCache.shouldTry(hostKey, nowMs)
  ) {
    return 'unsupported'
  }
  try {
    return await withTransferDeadline(async () => {
      const goal = await readCodexThreadGoal(args.threadId, args.originCodexHomePath)
      goalRpcCapabilityCache.rememberSupported(hostKey)
      if (!goal) {
        return 'no-goal' as const
      }
      await writeCodexThreadGoal(args.threadId, args.targetCodexHomePath, goal)
      return 'transferred' as const
    })
  } catch (error) {
    if (isCodexAppServerUnsupportedError(error)) {
      goalRpcCapabilityCache.rememberUnsupported(hostKey, nowMs)
      return 'unsupported'
    }
    console.warn('[codex-thread-goal] Failed to carry the goal across the account switch:', error)
    return 'failed'
  }
}

/**
 * Bounds the whole transfer, not each RPC.
 *
 * Why a race rather than a shorter per-session timeout alone: the transfer runs
 * two app-server sessions back to back, so per-session bounds still add up. The
 * abandoned work is safe to leave running — each session SIGKILLs its own child
 * when its deadline lapses.
 */
async function withTransferDeadline<T extends string>(
  run: () => Promise<T>
): Promise<T | 'failed'> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'failed'>((resolve) => {
    timer = setTimeout(() => resolve('failed'), GOAL_TRANSFER_DEADLINE_MS)
  })
  try {
    return await Promise.race([run(), deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function readCodexThreadGoal(
  threadId: string,
  codexHomePath: string
): Promise<CodexTransferableThreadGoal | null> {
  return runCodexAppServerSession(buildGoalInvocation(codexHomePath), async (rpc) =>
    parseCodexThreadGoal(await rpc.request('thread/goal/get', { threadId }))
  )
}

async function writeCodexThreadGoal(
  threadId: string,
  codexHomePath: string,
  goal: CodexTransferableThreadGoal
): Promise<void> {
  await runCodexAppServerSession(buildGoalInvocation(codexHomePath), async (rpc) => {
    // Why thread/read first: the rollout was hardlinked into this home moments
    // ago, so its thread row may not exist yet. thread/read is Codex's own lazy
    // indexing path and is what makes the thread addressable for the set below.
    await rpc.request('thread/read', { threadId })
    await rpc.request('thread/goal/set', {
      threadId,
      objective: goal.objective,
      ...(goal.status ? { status: goal.status } : {}),
      ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {})
    })
  })
}

export const _internals = {
  resetGoalRpcCapability: (): void => {
    goalRpcCapabilityCache.clear()
  }
}
