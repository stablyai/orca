import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { claudeDestinationBucket } from '../claude/claude-conversation-copy'
import { materializeClaudeConversationTranscript } from '../claude/claude-rewind-transcript'
import { homedir } from 'node:os'
import { getClaudeProfileRouter } from '../claude-accounts/profiles/routing/claude-profile-installed-router'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'

/** A terminal Claude chat's fork: a new conversation ending at one transcript entry, placed in the
 *  project folder Claude resumes from (the destination worktree's, or the source's). Null when the
 *  request asks for no cut, so the ordinary fork path handles it. */
export async function copyTerminalChatForkCut(
  args: AiVaultPrepareSessionResumeArgs
): Promise<AiVaultPrepareSessionResumeResult | null> {
  if (!args.fork || args.agent !== 'claude' || !args.forkThroughEntryId || !args.sessionId) {
    return null
  }
  const bucket = claudeDestinationBucket(args.destinationCwd)
  // Sessions sit in <home>/projects/<bucket>/<id>.jsonl, so the destination is a sibling bucket.
  const destinationDirectory = bucket ? join(dirname(dirname(args.filePath)), bucket) : undefined
  if (destinationDirectory) {
    await mkdir(destinationDirectory, { recursive: true })
  }
  const copy = await materializeClaudeConversationTranscript({
    sourcePath: args.filePath,
    sourceSessionId: args.sessionId,
    throughEntryId: args.forkThroughEntryId,
    ...(destinationDirectory ? { destinationDirectory } : {})
  })
  if (!copy) {
    throw new Error(
      'Claude could not find this message in the saved chat. Open the chat again and try again.'
    )
  }
  return {
    useRealCodexHome: false,
    forkedSession: { agent: 'claude', sessionId: copy.sessionId, filePath: copy.filePath }
  }
}

/** The phone's fork of a terminal Claude chat it names only by session id: find the transcript among
 *  this host's Claude homes, cut it, and describe the copy as a CLI fork source for this workspace. */
export async function prepareTerminalChatForkForWorkspace(
  sessionId: string,
  throughEntryId: string,
  workspacePath: string
): Promise<AiVaultPrepareSessionResumeResult> {
  const router = getClaudeProfileRouter()
  const homes = new Set([
    ...(router ? [...router.accountHomes(), router.systemDefaultHome()] : []),
    join(homedir(), '.claude')
  ])
  for (const home of homes) {
    const filePath = await resolveSessionFilePath('claude', sessionId, {
      claudeProjectsDir: join(home, 'projects')
    })
    if (!filePath) {
      continue
    }
    const cut = await copyTerminalChatForkCut({
      agent: 'claude',
      sessionId,
      filePath,
      codexHome: null,
      executionHostId: 'local',
      fork: true,
      forkThroughEntryId: throughEntryId,
      destinationCwd: workspacePath
    })
    const forked = cut?.forkedSession
    if (!forked) {
      break
    }
    return {
      ...cut,
      cliForkSource: {
        agent: 'claude',
        sessionId: forked.sessionId,
        filePath: forked.filePath ?? '',
        cwd: workspacePath,
        codexHome: null,
        executionHostPlatform: process.platform,
        sourceAgent: 'claude'
      }
    }
  }
  throw new Error('chat_fork_source_unavailable')
}
