import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { resolveSessionFilePath } from '../../../native-chat/session-file-resolver'
import { getSystemCodexHomePath } from '../../configuration/homes/codex-home-paths'
import { prepareCodexAccountRestartResume } from './codex-legacy-session-resume'

/** Codex resumes a thread only from a rollout in its own CODEX_HOME, and the background history
 *  bridge may not have linked it yet, so a chat moving accounts brings its rollout along first. */
export async function moveCodexThreadIntoAccountHome(args: {
  threadId: string
  /** Where the chat last ran; searched before every other known Codex home. */
  fromHome: string
  toHome: string
}): Promise<void> {
  const inTarget = await resolveSessionFilePath('codex', args.threadId, {
    codexSessionsDirs: [join(args.toHome, 'sessions')],
    strictErrors: true
  })
  if (inTarget) {
    return
  }
  const found =
    (await resolveSessionFilePath('codex', args.threadId, {
      codexSessionsDirs: [join(args.fromHome, 'sessions')]
    })) ?? (await resolveSessionFilePath('codex', args.threadId))
  if (!found) {
    // Never saved; Codex's own resume refusal decides what happens next.
    return
  }
  // A bridged symlink names its source; the file itself is what gets linked or copied.
  const transcriptPath = await realpath(found)
  await prepareCodexAccountRestartResume({
    // <home>/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
    sourceHome: resolve(transcriptPath, '../../../../..'),
    transcriptPath,
    targetHome: args.toHome,
    systemCodexHomePath: getSystemCodexHomePath()
  })
}
