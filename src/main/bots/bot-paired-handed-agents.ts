// A workspace handed to a bot from a paired computer keeps its link in that computer's store, and its
// agents run there: Activity asks that computer (its `worktree ps`, as `orca worktree ps --on` does)
// which of them are still under the bot's home, and what their agents are doing.
import type { Bot } from '../../shared/bot-types'
import type { BotHandedAgentObservation } from '../../shared/bots/bot-activity-handed-agents'
import type { RuntimeWorktreePsSummary } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import { toRuntimeExecutionHostId } from '../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

// Short: a slow or gone computer only leaves its rows out of this read.
const PAIRED_READ_TIMEOUT_MS = 5_000
// Activity re-reads on every bot change; one answer per computer serves a burst of them.
const PAIRED_READ_REUSE_MS = 10_000
// A computer that didn't answer (asleep, offline) isn't asked again until this has passed, longer
// after each miss in a row, so reads while it is away cost nothing.
const PAIRED_UNREACHABLE_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000, 120_000] as const

export type BotPairedRuntime = Pick<OrcaRuntimeService, 'bots' | 'callOrchestrationWorkerServer'>

/** A computer's answer, and when it was asked: it reflects that computer no earlier than `askedAt`.
 *  `misses` counts the failed asks in a row before it; a failed answer is kept until `retryAt`. */
type PsAnswer = {
  askedAt: number
  rows: Promise<readonly RuntimeWorktreePsSummary[]>
  misses: number
  retryAt: number | null
}
const answers = new WeakMap<BotPairedRuntime, Map<string, PsAnswer>>()

function answersOf(runtime: BotPairedRuntime): Map<string, PsAnswer> {
  const byEnvironment = answers.get(runtime) ?? new Map<string, PsAnswer>()
  answers.set(runtime, byEnvironment)
  return byEnvironment
}

/** The one read per paired computer every bot shares: an answer is reused for a while, and a miss
 *  is the answer until its backoff ends. */
function psAnswer(runtime: BotPairedRuntime, environmentId: string, now: number): PsAnswer {
  const byEnvironment = answersOf(runtime)
  const cached = byEnvironment.get(environmentId)
  if (cached) {
    const fresh =
      cached.retryAt === null ? now - cached.askedAt < PAIRED_READ_REUSE_MS : now < cached.retryAt
    if (fresh) {
      return cached
    }
  }
  const misses = cached?.retryAt !== null && cached ? cached.misses : 0
  const rows = runtime
    .callOrchestrationWorkerServer(environmentId, 'worktree.ps', {}, PAIRED_READ_TIMEOUT_MS)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `worktree.ps` answers RuntimeWorktreePsResult on every paired Orca; rows are read field by field below.
    .then((result) => (result as { worktrees?: RuntimeWorktreePsSummary[] }).worktrees ?? [])
  const answer: PsAnswer = { askedAt: now, rows, misses, retryAt: null }
  byEnvironment.set(environmentId, answer)
  rows.catch(() => {
    if (byEnvironment.get(environmentId) === answer) {
      const backoff =
        PAIRED_UNREACHABLE_BACKOFF_MS[Math.min(misses, PAIRED_UNREACHABLE_BACKOFF_MS.length - 1)]
      answer.misses = misses + 1
      answer.retryAt = now + backoff
    }
  })
  return answer
}

/** A hand-over on `environmentId` makes any answer read before it stale. */
export function forgetPairedReads(runtime: BotPairedRuntime, environmentId: string): void {
  answersOf(runtime).delete(environmentId)
}

/** The live and waiting agents in the bot's paired-computer workspaces. A workspace that computer
 *  now reports under another parent was moved away, and is forgotten; one it doesn't answer for is
 *  kept, since a missed read never proves a move. */
export async function readPairedHandedAgents(
  runtime: BotPairedRuntime,
  bot: Bot,
  now = Date.now()
): Promise<BotHandedAgentObservation[]> {
  const handed = bot.handedPairedWorkspaces ?? []
  if (handed.length === 0) {
    return []
  }
  const home = folderWorkspaceKey(bot.folderWorkspaceId)
  const environments = [...new Set(handed.map((entry) => entry.environmentId))]
  const answered = await Promise.all(
    environments.map(async (environmentId) => {
      const answer = psAnswer(runtime, environmentId, now)
      return {
        environmentId,
        askedAt: answer.askedAt,
        rows: await answer.rows.catch(() => null)
      }
    })
  )
  /** Workspaces an answer showed under another parent, with when that answer was asked. */
  const movedAway = new Map<string, number>()
  const agents: BotHandedAgentObservation[] = []
  for (const { environmentId, askedAt, rows } of answered) {
    if (!rows) {
      continue
    }
    const hostId = toRuntimeExecutionHostId(environmentId)
    for (const entry of handed.filter((item) => item.environmentId === environmentId)) {
      const row = rows.find((candidate) => candidate.worktreeId === entry.worktreeId)
      if (!row) {
        continue
      }
      if (row.crossStoreParent?.parent.workspaceKey !== home) {
        movedAway.set(`${environmentId}\0${entry.worktreeId}`, askedAt)
        continue
      }
      for (const agent of row.agents) {
        agents.push({
          paneKey: agent.paneKey,
          entry: {
            state: agent.state,
            ...(agent.workingMode ? { workingMode: agent.workingMode } : {}),
            prompt: agent.prompt,
            stateStartedAt: agent.stateStartedAt
          },
          worktreeId: row.worktreeId,
          ...(agent.taskTitle ? { taskTitle: agent.taskTitle } : {}),
          hostId
        })
      }
    }
  }
  if (movedAway.size > 0) {
    void runtime.bots
      .update(bot.id, (saved) => ({
        // Only an answer asked after the hand-over proves a move away; a hand-over registered (or
        // registered again) since keeps its entry.
        handedPairedWorkspaces: (saved.handedPairedWorkspaces ?? []).filter((item) => {
          const askedAt = movedAway.get(`${item.environmentId}\0${item.worktreeId}`)
          return askedAt === undefined || askedAt <= (item.at ?? 0)
        })
      }))
      .catch((error: unknown) => console.warn('[bots] could not forget a moved workspace', error))
  }
  return agents
}
