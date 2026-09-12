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

/** Transfers goals through Codex RPC, preserving the remaining user budget. */

// Bound each app-server session without leaving an abandoned write running.
const GOAL_RPC_TIMEOUT_MS = 4_000

const CODEX_GOAL_STATUSES = new Set([
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete'
])

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
  let status = resolveGoalStatusAfterAccountMove(record.status)
  const tokenBudget = record.tokenBudget ?? record.token_budget
  const tokensUsed = record.tokensUsed ?? record.tokens_used
  let remainingBudget: number | undefined
  if (typeof tokenBudget === 'number' && Number.isFinite(tokenBudget) && tokenBudget > 0) {
    if (typeof tokensUsed === 'number' && Number.isFinite(tokensUsed) && tokensUsed >= 0) {
      remainingBudget = Math.max(1, tokenBudget - tokensUsed)
      if (tokensUsed >= tokenBudget && status !== 'complete') {
        status = 'budgetLimited'
      }
    } else {
      // An unknown consumed budget must not silently become a fresh spending allowance.
      remainingBudget = tokenBudget
      if (status !== 'complete' && status !== 'budgetLimited') {
        status = 'paused'
      }
    }
  }
  return {
    objective,
    ...(status ? { status } : {}),
    ...(remainingBudget !== undefined ? { tokenBudget: remainingBudget } : {})
  }
}

function resolveGoalStatusAfterAccountMove(status: unknown): string | null {
  if (typeof status !== 'string' || status.length === 0) {
    return null
  }
  if (status === 'usageLimited' || status === 'usage_limited') {
    return 'active'
  }
  if (status === 'budget_limited') {
    return 'budgetLimited'
  }
  // Why dropped rather than forwarded: `thread/goal/set` rejects a status it does
  // not know, and that rejection would fail the whole transfer — losing the
  // objective too, over a field the new account can default for itself.
  return CODEX_GOAL_STATUSES.has(status) ? status : null
}

function buildGoalInvocation(codexHomePath: string): CodexAppServerInvocation {
  const command = resolveCodexCommand()
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, ['app-server'])
  return {
    command: spawnCmd,
    args: spawnArgs,
    cliPath: command,
    // Why: the daemon environment can carry another account's CODEX_HOME, which
    // would read or write the wrong account's goals DB.
    env: { CODEX_HOME: codexHomePath },
    timeoutMs: GOAL_RPC_TIMEOUT_MS
  }
}

/** Reports transfer failures so the restart can refuse to lose a known goal. */
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
    return await (async () => {
      const goal = await readCodexThreadGoal(args.threadId, args.originCodexHomePath)
      goalRpcCapabilityCache.rememberSupported(hostKey)
      if (!goal) {
        return 'no-goal' as const
      }
      await writeCodexThreadGoal(args.threadId, args.targetCodexHomePath, goal)
      return 'transferred' as const
    })()
  } catch (error) {
    if (isCodexAppServerUnsupportedError(error)) {
      goalRpcCapabilityCache.rememberUnsupported(hostKey, nowMs)
      return 'unsupported'
    }
    console.warn('[codex-thread-goal] Failed to carry the goal across the account switch:', error)
    return 'failed'
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
