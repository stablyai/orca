import type { AutomationRun } from '../shared/automations-types'
import type { RuntimeRpcSuccess } from '../shared/runtime-rpc-envelope'
import { RuntimeClientError, type RuntimeClient } from './runtime-client'

// Why 25: a snapshot can reach ~200 KB, so 25 runs stay under a remote reply's 4 MB in practice.
export const AUTOMATION_RUNS_PAGE_SIZE = 25
const REPLY_TOO_LARGE = 'reply_too_large'

type RunsReply = { runs: AutomationRun[]; nextCursor?: string | null }

type RunsQuery = { automationId?: string; limit: number; cursor?: string }

/** Sends one `automation.runs` request. */
export type AutomationRunsRpc = (
  params: Partial<RunsQuery>
) => Promise<RuntimeRpcSuccess<RunsReply>>

export function automationRunsRpc(client: Pick<RuntimeClient, 'call'>): AutomationRunsRpc {
  return (params) => client.call<RunsReply>('automation.runs', params)
}

function callRunsPage(rpc: AutomationRunsRpc, query: RunsQuery) {
  return rpc({
    ...(query.automationId ? { automationId: query.automationId } : {}),
    limit: query.limit,
    ...(query.cursor ? { cursor: query.cursor } : {})
  })
}

async function readShrinkingPage(
  rpc: AutomationRunsRpc,
  query: RunsQuery
): Promise<{ page: RuntimeRpcSuccess<RunsReply>; limit: number }> {
  let limit = query.limit
  for (;;) {
    try {
      return { page: await callRunsPage(rpc, { ...query, limit }), limit }
    } catch (error) {
      if (!(error instanceof RuntimeClientError) || error.code !== REPLY_TOO_LARGE || limit <= 1) {
        throw error
      }
      limit = Math.floor(limit / 2)
    }
  }
}

/** One page, halving the page size while the remote host refuses the reply as too large. */
export async function readAutomationRunsPage(
  rpc: AutomationRunsRpc,
  query: RunsQuery
): Promise<RuntimeRpcSuccess<RunsReply>> {
  return (await readShrinkingPage(rpc, query)).page
}

/**
 * Every run, read page by page so no single reply has to carry the whole history (#28254).
 * A host older than paging ignores `limit` and returns everything with no cursor, ending the loop.
 */
export async function readAllAutomationRuns(
  rpc: AutomationRunsRpc,
  automationId: string | undefined
): Promise<RuntimeRpcSuccess<{ runs: AutomationRun[] }>> {
  const runs: AutomationRun[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let limit = AUTOMATION_RUNS_PAGE_SIZE
  for (;;) {
    // Why carry the limit: the next page is likely as heavy as the one that had to shrink.
    const read = await readShrinkingPage(rpc, { automationId, limit, cursor })
    const page = read.page
    limit = read.limit
    runs.push(...page.result.runs)
    const next = page.result.nextCursor
    if (!next || seenCursors.has(next)) {
      return { ...page, result: { runs } }
    }
    seenCursors.add(next)
    cursor = next
  }
}
