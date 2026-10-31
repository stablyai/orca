import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { errnoCodeOrUnknown } from '../../shared/errno-code'
import { refreshConversationFileCopy } from '../agent-conversation-file-install'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'

/** The transcript in `home` and when it last changed; null when absent. An account other than the
 *  one the chat ran on is also skipped when unreadable; any other failure fails the move. */
async function claudeTranscriptIn(
  sessionId: string,
  home: string,
  ranHere: boolean
): Promise<{ transcript: string; mtimeMs: number } | null> {
  try {
    const transcript = await resolveSessionFilePath('claude', sessionId, {
      claudeProjectsDir: join(home, 'projects')
    })
    return transcript ? { transcript, mtimeMs: (await stat(transcript)).mtimeMs } : null
  } catch (error) {
    // Skipping where it ran could let an older copy win and drop its newest turns.
    if (!ranHere && ['ENOENT', 'EACCES', 'EPERM'].includes(errnoCodeOrUnknown(error))) {
      return null
    }
    throw error
  }
}

/** A chat's Claude transcript, made resumable from `targetHome` at the same project path from its
 *  newest copy. Accounts that share history already have it; false when no known home holds it. */
export async function carryClaudeConversationToAccountHome(args: {
  sessionId: string
  /** Homes the conversation may have run in; the first is the one it last ran in. */
  sourceHomes: readonly string[]
  targetHome: string
}): Promise<boolean> {
  let newest: { home: string; transcript: string; mtimeMs: number } | null = null
  const [ranIn] = args.sourceHomes
  for (const home of [args.targetHome, ...args.sourceHomes]) {
    const found = await claudeTranscriptIn(args.sessionId, home, home === ranIn)
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
