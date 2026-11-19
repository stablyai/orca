import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AiVaultCommitChatForkImportResult } from '../../../shared/rpc-contract/ai-vault/ai-vault-fork-transfer-params'
import { getClaudeProfileRouter } from '../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { claudeDestinationBucket } from '../../claude/transcripts/claude-conversation-copy'
import { materializeClaudeConversationTranscript } from '../../claude/transcripts/claude-rewind-transcript'
import type { AiVaultPrepareSessionResumeResult } from '../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { chatForkTransferStore } from './chat-fork-transfer-store'
import { ChatForkTransferError, type StagedChatForkImport } from './chat-fork-transfer-ownership'

/** The Claude home a chat launched on this host reads, so `claude --resume` finds the placed copy. */
export function claudeImportHome(): string {
  const router = getClaudeProfileRouter()
  return router?.routedHome() ?? router?.systemDefaultHome() ?? join(homedir(), '.claude')
}

/** Rewrites an uploaded transcript as a new chat in the workspace's Claude project: the SDK mints its
 *  id and rewrites every entry, so the upload chooses neither its id nor where it lands. */
export async function placeChatForkImport(
  staged: StagedChatForkImport,
  home = claudeImportHome()
): Promise<AiVaultCommitChatForkImportResult> {
  const bucket = claudeDestinationBucket(staged.workspacePath)
  if (!bucket) {
    throw new ChatForkTransferError('chat_fork_import_target_unsupported')
  }
  const copy = await materializeClaudeConversationTranscript({
    sourcePath: staged.filePath,
    sourceSessionId: staged.sourceSessionId,
    destinationDirectory: join(home, 'projects', bucket),
    rewriteCwd: staged.workspacePath,
    signal: AbortSignal.timeout(120_000),
    ...(staged.title ? { title: staged.title } : {})
  })
  if (!copy) {
    throw new ChatForkTransferError('chat_fork_transfer_integrity_failed')
  }
  return {
    agent: 'claude',
    sessionId: copy.sessionId,
    filePath: copy.filePath,
    cwd: staged.workspacePath,
    worktreeId: staged.worktreeId,
    resumeCursor: copy.resumeCursor
  }
}

/** A placed import as the CLI fork source a terminal create launches, only in the worktree it was
 *  placed for and only for the caller that imported it. */
export function chatForkImportLaunchSource(
  ref: { importId: string; owner: string },
  worktreeId: string,
  store = chatForkTransferStore()
): AiVaultPrepareSessionResumeResult {
  const launch = store.findLaunch(ref.owner, ref.importId)
  if (!launch || launch.worktreeId !== worktreeId) {
    throw new Error('chat_fork_source_unavailable')
  }
  return {
    useRealCodexHome: false,
    forkedSession: { agent: 'claude', sessionId: launch.sessionId, filePath: launch.filePath },
    cliForkSource: {
      agent: 'claude',
      sessionId: launch.sessionId,
      filePath: launch.filePath,
      cwd: launch.cwd,
      codexHome: null,
      executionHostPlatform: process.platform,
      sourceAgent: 'claude'
    }
  }
}
