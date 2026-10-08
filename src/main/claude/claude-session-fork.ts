import { findWorkerThreadEntryPath } from '../worker-thread-entry-path'
import { runWorkerThreadJob } from '../worker-thread-job'

export type ClaudeSessionForkJob = {
  providerSessionId: string
  /** The last transcript entry the copy keeps. */
  upToMessageId: string
}

const WORKER_FILENAME = 'claude-session-fork-worker-entry.js'

/** Copy a Claude conversation through one of its entries; resolves with the copy's session id.
 *  On a thread of its own, since the SDK finds the account only through `CLAUDE_CONFIG_DIR`. */
export function forkClaudeSession(
  job: ClaudeSessionForkJob & { claudeConfigDir: string },
  path = findWorkerThreadEntryPath(__dirname, WORKER_FILENAME)
): Promise<string> {
  const { claudeConfigDir, ...workerData } = job
  return runWorkerThreadJob({
    path,
    workerData,
    label: 'Claude session fork',
    timeoutMs: 30_000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir }
  })
}
