import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { refreshConversationFileCopy } from '../agent-conversation-file-install'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'

async function claudeTranscriptIn(sessionId: string, home: string): Promise<string | null> {
  return resolveSessionFilePath('claude', sessionId, {
    claudeProjectsDir: join(home, 'projects')
  })
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
    const transcript = await claudeTranscriptIn(args.sessionId, home)
    if (!transcript) {
      continue
    }
    const { mtimeMs } = await stat(transcript)
    if (!newest || mtimeMs > newest.mtimeMs) {
      newest = { home, transcript, mtimeMs }
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
