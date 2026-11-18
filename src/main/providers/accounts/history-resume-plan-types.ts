import type { AiVaultPrepareSessionResumeArgs } from '../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import type {
  HistoryResumeAccount,
  HistoryResumePlan
} from '../../../shared/ai-vault/resume/history-resume-accounts'
import type { verifiedWorkspaceConversation } from './workspace-conversation-source'
import type { HistoryContinuationLedger } from './history-continuation-ledger'
import type { forkHistoryConversation } from './history-conversation-fork'
import type { healPendingCodexAccountThreads } from '../../codex/history/index/codex-account-session-index-heal'
export type Provider = 'codex' | 'claude'
export type Source = Awaited<ReturnType<typeof verifiedWorkspaceConversation>>
export type Pending = {
  args: AiVaultPrepareSessionResumeArgs
  source: Source
  sessionId: string
  rootSessionId: string
  rootTranscriptKey: string
  lastAccountId?: string | null
  plan: HistoryResumePlan
  expires: number
  preparing?: boolean
}
export type HistoryResumePlannerDeps = {
  ledger: HistoryContinuationLedger
  roots(provider: Provider): Promise<readonly string[]>
  workspacePath(id: string): string | undefined
  accounts(
    provider: Provider,
    workspaceId: string
  ): { accounts: HistoryResumeAccount[]; workspaceAccountId?: string | null }
  prepareAccount(provider: Provider, accountId: string | null): Promise<string>
  fork?: typeof forkHistoryConversation
  heal?: typeof healPendingCodexAccountThreads
}
