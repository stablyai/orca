import { mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { claudeDestinationBucket } from '../claude/transcripts/claude-conversation-copy'
import { materializeClaudeConversationTranscript } from '../claude/transcripts/claude-rewind-transcript'
import { homedir } from 'node:os'
import { getClaudeProfileRouter } from '../claude-accounts/profiles/routing/claude-profile-installed-router'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { isWslUncPath } from '../../shared/file-access/wsl-paths'

/** A terminal Claude chat's fork: a new conversation ending at one transcript entry, placed in the
 *  project folder Claude resumes from (the destination worktree's, or the source's). Null when the
 *  request asks for no cut, so the ordinary path handles it; a cut it cannot honor throws. */
export async function copyTerminalChatForkCut(
  args: AiVaultPrepareSessionResumeArgs
): Promise<AiVaultPrepareSessionResumeResult | null> {
  if (!args.forkThroughEntryId) {
    return null
  }
  // An uncut fallback would hand back messages after the requested point.
  if (!args.fork || args.agent !== 'claude' || !args.sessionId) {
    throw new Error(
      'This chat cannot be forked at that message. Open the chat again and try again.'
    )
  }
  // Sessions sit in <home>/projects/<bucket>/<id>.jsonl; the copy goes where the new terminal's
  // Claude resumes from: the launch's home and the destination worktree's bucket.
  const bucket = claudeDestinationBucket(args.destinationCwd) ?? basename(dirname(args.filePath))
  const destinationDirectory = join(claudeTerminalLaunchProjectsDir(args.filePath), bucket)
  await mkdir(destinationDirectory, { recursive: true })
  const copy = await materializeClaudeConversationTranscript({
    sourcePath: args.filePath,
    sourceSessionId: args.sessionId,
    throughEntryId: args.forkThroughEntryId,
    destinationDirectory
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

/** The projects folder of the Claude home a new terminal launches with (the routed account's, or
 *  the system default); the source's own home for a WSL chat or when routing is unavailable. */
function claudeTerminalLaunchProjectsDir(sourcePath: string): string {
  if (isWslUncPath(sourcePath)) {
    return dirname(dirname(sourcePath))
  }
  try {
    const home = getClaudeProfileRouter()?.preparation().configDir
    if (home) {
      return join(home, 'projects')
    }
  } catch {
    // A missing routed folder fails the launch itself with its own message.
  }
  return dirname(dirname(sourcePath))
}

/** The phone's fork of a terminal Claude chat it names only by session id: find the transcript among
 *  this host's Claude homes, cut it, and describe the copy as a CLI fork source for this workspace. */
export async function prepareTerminalChatForkForWorkspace(
  sessionId: string,
  throughEntryId: string,
  workspacePath: string
): Promise<AiVaultPrepareSessionResumeResult> {
  const filePath = await findClaudeTerminalTranscript(sessionId)
  if (filePath) {
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
    if (forked) {
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
  }
  throw new Error('chat_fork_source_unavailable')
}

/** A terminal Claude chat's transcript, found by session id among this host's Claude homes. */
export async function findClaudeTerminalTranscript(sessionId: string): Promise<string | null> {
  const router = getClaudeProfileRouter()
  const homes = new Set([
    ...(router ? [...router.accountHomes(), router.systemDefaultHome()] : []),
    join(homedir(), '.claude')
  ])
  for (const home of homes) {
    const filePath = await resolveSessionFilePath('claude', sessionId, {
      claudeProjectsDir: join(home, 'projects')
    })
    if (filePath) {
      return filePath
    }
  }
  return null
}
