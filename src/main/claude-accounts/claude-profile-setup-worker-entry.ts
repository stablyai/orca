import { parentPort, workerData } from 'node:worker_threads'
import { ClaudeHookService } from '../claude/hook-service'
import type { WorkerThreadJobReply } from '../worker-thread-job'
import {
  provisionClaudeAccountProfile,
  type ClaudeProfileSetupReport
} from './claude-profile-setup'
import type { ClaudeProfileSetupJob } from './claude-profile-setup-worker'

if (!parentPort) {
  throw new Error('Claude account setup must run on a worker thread')
}
const port = parentPort
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: runClaudeProfileSetupInWorker is the only spawner and passes a ClaudeProfileSetupJob.
const job = workerData as ClaudeProfileSetupJob
const reply = (message: WorkerThreadJobReply<ClaudeProfileSetupReport>): void =>
  port.postMessage(message)

void provisionClaudeAccountProfile({
  dataRoot: job.dataRoot,
  profile: job.profile,
  userHome: job.userHome,
  userConfigDir: job.userConfigDir,
  installHooks: job.hooks
    ? ({ configDir }) =>
        new ClaudeHookService().install({ configDir, claudeVersion: job.claudeVersion })
    : null
})
  .then(
    (report) => reply({ ok: true, value: report }),
    (error: unknown) => reply({ ok: false, error: String(error) })
  )
  .finally(() => port.close())
