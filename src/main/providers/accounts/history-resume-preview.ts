import { randomUUID } from 'node:crypto'
import type { AiVaultPrepareSessionResumeArgs } from '../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import type { HistoryResumePlan } from '../../../shared/ai-vault/resume/history-resume-accounts'
import {
  historyTranscriptKey,
  historyContinuationRootKey
} from '../../../shared/ai-vault/resume/history-transcript-identity'
import { verifiedWorkspaceConversation } from './workspace-conversation-source'
import type { HistoryResumePlannerDeps, Pending } from './history-resume-plan-types'
export async function previewHistoryResume(
  deps: HistoryResumePlannerDeps,
  args: AiVaultPrepareSessionResumeArgs
): Promise<Pending> {
  if ((args.agent !== 'codex' && args.agent !== 'claude') || !args.sessionId || !args.workspaceId) {
    throw new Error('Invalid resume request.')
  }
  const requested = await verifiedWorkspaceConversation({
    provider: args.agent,
    filePath: args.filePath,
    sessionId: args.sessionId,
    roots: await deps.roots(args.agent)
  })
  const entries = await deps.ledger.list()
  const recorded = entries.find(
    (entry) =>
      entry.provider === args.agent &&
      entry.sessionId === args.sessionId &&
      historyTranscriptKey(entry.provider, entry.filePath) ===
        historyTranscriptKey(args.agent, requested.filePath)
  )
  const rootSessionId = recorded?.rootSessionId ?? args.sessionId
  const rootTranscriptKey = recorded
    ? historyContinuationRootKey(recorded, entries)
    : historyTranscriptKey(args.agent, requested.filePath)
  const last = args.exactVersion
    ? recorded
    : entries
        .filter(
          (entry) =>
            entry.provider === args.agent &&
            historyContinuationRootKey(entry, entries) === rootTranscriptKey &&
            entry.openedAt > 0
        )
        .toReversed()
        .sort((a, b) => b.openedAt - a.openedAt)[0]
  const sessionId = last?.sessionId ?? args.sessionId
  const source = await verifiedWorkspaceConversation({
    provider: args.agent,
    filePath: last?.filePath ?? args.filePath,
    sessionId,
    roots: await deps.roots(args.agent)
  }).catch((error) => {
    if (last && !args.exactVersion) {
      return requested
    }
    throw error
  })
  const sourceSessionId = source === requested ? args.sessionId : sessionId
  const { accounts, workspaceAccountId } = deps.accounts(args.agent, args.workspaceId)
  const lastAccountId = source === requested ? recorded?.accountId : last?.accountId
  const plan: HistoryResumePlan = {
    token: randomUUID(),
    accounts,
    lastAccountId,
    workspaceAccountId,
    needsChoice:
      lastAccountId === undefined ||
      (workspaceAccountId !== undefined && workspaceAccountId !== lastAccountId) ||
      !accounts.some((account) => account.id === lastAccountId && account.available)
  }
  return {
    args,
    source,
    sessionId: sourceSessionId,
    rootSessionId,
    rootTranscriptKey,
    lastAccountId,
    plan,
    expires: Date.now() + 300_000
  }
}
