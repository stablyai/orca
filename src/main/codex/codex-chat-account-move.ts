import { join } from 'node:path'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { refreshConversationFileCopy } from '../agent-conversation-file-install'
import { prepareCodexAccountRestartResume } from './codex-legacy-session-resume'
import { findTrustedCodexSessionResume } from './codex-session-resume-home'

async function findRollout(threadId: string, home: string) {
  return findTrustedCodexSessionResume({
    sessionId: threadId,
    transcriptPath: undefined,
    trustedCodexHomes: [home],
    getSelectedAccountCodexHome: () => home,
    systemCodexHomePath: null,
    sharedRuntimeCodexHomePath: null
  })
}

/** A chat's Codex thread, made resumable from `targetHome` with the terminals' restart step.
 *  False when no rollout of the thread exists in either home. */
export async function carryCodexThreadToAccountHome(args: {
  threadId: string
  sourceHome: string
  targetHome: string
  systemCodexHomePath: string
}): Promise<boolean> {
  // The account it last ran on holds the newest turns; a copy the target kept from before may be stale.
  const found = await findRollout(args.threadId, args.sourceHome)
  if (!found) {
    return (await findRollout(args.threadId, args.targetHome)) !== null
  }
  const relative = relativePathInsideRoot(found.homePath, found.transcriptPath)
  if (relative) {
    await refreshConversationFileCopy(found.transcriptPath, join(args.targetHome, relative))
  }
  await prepareCodexAccountRestartResume({
    sourceHome: found.homePath,
    transcriptPath: found.transcriptPath,
    targetHome: args.targetHome,
    systemCodexHomePath: args.systemCodexHomePath
  })
  return true
}
