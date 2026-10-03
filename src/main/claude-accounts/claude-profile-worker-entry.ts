import { parentPort } from 'node:worker_threads'
import { ClaudeHookService } from '../claude/hook-service'
import { provisionClaudeAccountProfile } from './claude-profile-setup'
import type {
  ClaudeProfileWorkerRequest,
  ClaudeProfileWorkerResponse
} from './claude-profile-worker-contract'

parentPort?.on('message', async ({ id, job }: ClaudeProfileWorkerRequest) => {
  let response: ClaudeProfileWorkerResponse
  try {
    const report = await provisionClaudeAccountProfile({
      ...job,
      installHooks: job.hooksEnabled
        ? (target) =>
            new ClaudeHookService().install({ ...target, claudeVersion: job.claudeVersion })
        : null
    })
    response = { id, ok: true, report }
  } catch (error) {
    response = { id, ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  parentPort?.postMessage(response)
})
