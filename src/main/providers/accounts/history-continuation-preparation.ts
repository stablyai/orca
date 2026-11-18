import { unlink } from 'node:fs/promises'
import { normalizeRuntimePathForComparison } from '../../../shared/file-access/cross-platform-path'
import { historyTranscriptKey } from '../../../shared/ai-vault/resume/history-transcript-identity'
import { forkHistoryConversation } from './history-conversation-fork'
import { verifiedWorkspaceConversation } from './workspace-conversation-source'
import { healPendingCodexAccountThreads } from '../../codex/history/index/codex-account-session-index-heal'
import { parseCodexRolloutThreadId } from '../../codex/history/rollouts/codex-rollout-thread-id'
import type {
  HistoryResumePlannerDeps,
  Pending,
  Provider,
  Source
} from './history-resume-plan-types'

const preparing = new Map<string, Promise<{ sessionId: string; filePath: string }>>()

export function prepareHistoryConversation(
  deps: HistoryResumePlannerDeps,
  pending: Pending,
  source: Source,
  provider: Provider,
  accountId: string | null,
  targetHome: string
): Promise<{ sessionId: string; filePath: string }> {
  const sourceKey = historyTranscriptKey(provider, source.filePath)
  const key = JSON.stringify([sourceKey, targetHome, accountId])
  const active = preparing.get(key)
  if (active) {
    return active
  }
  const operation = prepare()
  preparing.set(key, operation)
  void operation.finally(() => preparing.delete(key)).catch(() => {})
  return operation

  async function prepare() {
    const roots = await deps.roots(provider)
    const saved = (await deps.ledger.list()).find(
      (entry) =>
        entry.provider === provider &&
        entry.openedAt === 0 &&
        entry.preparedAccountId === accountId &&
        entry.parentTranscriptKey === sourceKey &&
        normalizeRuntimePathForComparison(entry.home) ===
          normalizeRuntimePathForComparison(targetHome)
    )
    let copy: { sessionId: string; filePath: string } | undefined
    if (saved) {
      await verifiedWorkspaceConversation({
        provider,
        filePath: saved.filePath,
        sessionId: saved.sessionId,
        roots
      })
      copy = { sessionId: saved.sessionId, filePath: saved.filePath }
    }
    if (!copy) {
      copy = await (deps.fork ?? forkHistoryConversation)({
        provider,
        ...source,
        sessionId: pending.sessionId,
        targetHome,
        historyRoots: roots
      })
      try {
        await deps.ledger.record({
          provider,
          ...copy,
          home: targetHome,
          rootSessionId: pending.rootSessionId,
          rootTranscriptKey: pending.rootTranscriptKey,
          parentSessionId: pending.sessionId,
          parentTranscriptKey: sourceKey,
          preparedAccountId: accountId,
          openedAt: 0
        })
      } catch (error) {
        // This operation owns only the newly published transcript, never the source or account home.
        await unlink(copy.filePath).catch(() => {})
        throw error
      }
    }
    if (provider === 'codex') {
      const rollout = parseCodexRolloutThreadId(copy.filePath)
      if (!rollout) {
        throw new Error('The continuation has no valid rollout identity.')
      }
      const result = await (deps.heal ?? healPendingCodexAccountThreads)(
        targetHome,
        new Map([[copy.sessionId, rollout.rolloutStamp]]),
        { retryFailed: true }
      )
      if (
        result.failedThreads ||
        result.missingThreads ||
        !['completed', 'up-to-date'].includes(result.outcome)
      ) {
        throw new Error(
          'The continuation could not be indexed. Retry Resume to repair the same copy. The original session was preserved.'
        )
      }
    }
    return copy
  }
}
