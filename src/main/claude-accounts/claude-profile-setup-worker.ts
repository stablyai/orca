import { findWorkerThreadEntryPath } from '../worker-thread-entry-path'
import { runWorkerThreadJob } from '../worker-thread-job'
import type { ClaudeProfileDescriptor } from './claude-profile-paths'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'

export type ClaudeProfileSetupJob = {
  dataRoot: string
  profile: ClaudeProfileDescriptor
  userHome: string
  userConfigDir: string | undefined
  hooks: boolean
  claudeVersion: string | undefined
}

const WORKER_FILENAME = 'claude-profile-setup-worker-entry.js'

/** One worker per setup: a first setup can merge a large history tree with sync fs calls. */
export function runClaudeProfileSetupInWorker(
  job: ClaudeProfileSetupJob,
  path = findWorkerThreadEntryPath(__dirname, WORKER_FILENAME),
  timeoutMs = 60_000
): Promise<ClaudeProfileSetupReport> {
  return runWorkerThreadJob({ path, workerData: job, label: 'Claude account setup', timeoutMs })
}
