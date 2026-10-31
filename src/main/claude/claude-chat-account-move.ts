import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { refreshConversationFileCopy } from '../agent-conversation-file-install'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'

/** The transcript in `home` and when it last changed; null when absent or unreadable there. */
async function claudeTranscriptIn(
  sessionId: string,
  home: string
): Promise<{ transcript: string; mtimeMs: number } | null> {
  try {
    const transcript = await resolveSessionFilePath('claude', sessionId, {
      claudeProjectsDir: join(home, 'projects')
    })
    return transcript ? { transcript, mtimeMs: (await stat(transcript)).mtimeMs } : null
  } catch {
    // One unreadable account must not keep the chat from the others.
    return null
  }
}

/** A chat's Claude transcript, made resumable from `targetHome` at the same project path from its
 *  newest copy. Accounts that share history already have it; false when no known home holds it. */
export async function carryClaudeConversationToAccountHome(args: {
  sessionId: string
  /** Homes the conversation may have run in. */
  sourceHomes: readonly string[]
  targetHome: string
}): Promise<boolean> {
  let newest: { home: string; transcript: string; mtimeMs: number } | null = null
  for (const home of [args.targetHome, ...args.sourceHomes]) {
    const found = await claudeTranscriptIn(args.sessionId, home)
    if (found && (!newest || found.mtimeMs > newest.mtimeMs)) {
      newest = { home, ...found }
    }
  }
  if (!newest) {
    return false
  }
  const relative = relativePathInsideRoot(join(newest.home, 'projects'), newest.transcript)
  if (relative) {
    await refreshConversationFileCopy(
      newest.transcript,
      join(args.targetHome, 'projects', relative)
    )
  }
  return true
}
