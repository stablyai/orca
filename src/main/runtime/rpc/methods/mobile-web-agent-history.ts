import { z } from 'zod'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  MOBILE_WEB_AGENT_HISTORY_PAGE_LIMIT,
  MOBILE_WEB_AGENT_HISTORY_QUERY_MAX_LENGTH,
  MOBILE_WEB_AGENT_HISTORY_SESSION_ID_MAX_LENGTH
} from '../../../../shared/mobile-web/agent-history-operation-contract'
import { deriveMobileAiVaultScopePaths } from '../../../../shared/mobile-ai-vault-scope-paths'
import { defineMethod, type RpcContext } from '../core'
import {
  mobileWebAgentHistoryRpc,
  type MobileWebAgentHistoryWorktree
} from './mobile-web-agent-history-rpc'
import {
  boundedCount,
  filterMobileWebAgentHistorySessions,
  projectMobileWebAgentHistory,
  projectMobileWebAgentHistoryPreview
} from './mobile-web-agent-history-projection'
import { resumeMobileWebAgentHistorySession } from './mobile-web-agent-history-resume'

const Scope = z.object({
  worktree: z.string().min(1).max(4096),
  scope: z.enum(['workspace', 'project', 'all'])
})
const SessionRef = Scope.extend({
  agent: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(MOBILE_WEB_AGENT_HISTORY_SESSION_ID_MAX_LENGTH)
})

export const MOBILE_WEB_AGENT_HISTORY_METHODS = [
  defineMethod({
    name: 'mobileWeb.agentHistory.snapshot',
    params: Scope.extend({
      query: z.string().max(MOBILE_WEB_AGENT_HISTORY_QUERY_MAX_LENGTH),
      force: z.boolean(),
      offset: z.number().int().nonnegative().max(100_000).optional()
    }),
    handler: async (params, context) => {
      const scan = await scanHistory(params, context)
      const sessions = projectMobileWebAgentHistory({
        sessions: scan.sessions,
        activeWorktreePath: scan.activeWorktree?.path ?? null
      })
      const offset = params.offset ?? 0
      const page = sessions.slice(offset, offset + MOBILE_WEB_AGENT_HISTORY_PAGE_LIMIT)
      const nextOffset = offset + page.length
      return {
        // The desktop serving a hybrid page always has the scanner; the field stays for the page.
        supported: true,
        sessions: page,
        skippedTranscriptCount: boundedCount(scan.issues.length, 10_000),
        nextOffset: nextOffset < sessions.length ? nextOffset : null
      }
    }
  }),
  defineMethod({
    name: 'mobileWeb.agentHistory.preview',
    params: SessionRef,
    handler: async (params, context) =>
      projectMobileWebAgentHistoryPreview(await requireSession(params, context))
  }),
  defineMethod({
    name: 'mobileWeb.agentHistory.resume',
    params: SessionRef,
    handler: async (params, context) =>
      resumeMobileWebAgentHistorySession({
        session: await requireSession(params, context),
        activeWorktreeId: worktreeIdFromSelector(params.worktree),
        context
      })
  })
]

type HistoryScope = z.infer<typeof Scope> & { query: string; force: boolean }

async function scanHistory(
  params: HistoryScope,
  context: RpcContext
): Promise<{
  sessions: AiVaultSession[]
  issues: readonly unknown[]
  activeWorktree: MobileWebAgentHistoryWorktree | undefined
}> {
  const rpc = mobileWebAgentHistoryRpc(context)
  const worktrees = await rpc.worktrees()
  const activeWorktreeId = worktreeIdFromSelector(params.worktree)
  const activeWorktree = worktrees.find((worktree) => worktree.worktreeId === activeWorktreeId)
  if (!activeWorktree) {
    throw new Error('selector_not_found')
  }
  const scopePaths = deriveMobileAiVaultScopePaths(params.scope, activeWorktree ?? null, worktrees)
  const scanned = await rpc.sessions({ force: params.force, scopePaths })
  return {
    sessions: filterMobileWebAgentHistorySessions(scanned.sessions, {
      scope: params.scope,
      query: params.query,
      scopePaths
    }),
    issues: scanned.issues,
    activeWorktree
  }
}

/** A session is named by the ids the scan itself reports. Two transcripts can share one provider
 *  id, so the most recently updated one wins, which is the row the page just listed. */
async function requireSession(
  params: z.infer<typeof SessionRef>,
  context: RpcContext
): Promise<AiVaultSession> {
  const scan = await scanHistory({ ...params, query: '', force: false }, context)
  const matches = scan.sessions.filter(
    (session) => session.agent === params.agent && session.sessionId === params.sessionId
  )
  const session = matches.sort((left, right) => updatedAtMs(right) - updatedAtMs(left))[0]
  if (!session) {
    throw new Error('selector_not_found')
  }
  return session
}

function updatedAtMs(session: AiVaultSession): number {
  const parsed = Date.parse(session.updatedAt ?? session.modifiedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The shell always addresses a worktree by id, so a selector of any other shape is not ours. */
function worktreeIdFromSelector(worktree: string): string {
  if (!worktree.startsWith('id:')) {
    throw new Error('selector_not_found')
  }
  return worktree.slice('id:'.length)
}
