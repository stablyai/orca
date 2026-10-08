import { parentPort, workerData } from 'node:worker_threads'
import type { WorkerThreadJobReply } from '../worker-thread-job'
import type { ClaudeSessionForkJob } from './claude-session-fork'

if (!parentPort) {
  throw new Error('A Claude session fork must run on a worker thread')
}
const port = parentPort
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forkClaudeSession is the only spawner and passes a ClaudeSessionForkJob.
const job = workerData as ClaudeSessionForkJob
const reply = (message: WorkerThreadJobReply<string>): void => port.postMessage(message)

// Imported at run time: the SDK is an ES module, and this entry is built as CommonJS.
void import('@anthropic-ai/claude-agent-sdk')
  .then(({ forkSession }) =>
    forkSession(job.providerSessionId, { upToMessageId: job.upToMessageId })
  )
  .then(
    ({ sessionId }) => reply({ ok: true, value: sessionId }),
    (error: unknown) => reply({ ok: false, error: String(error) })
  )
  .finally(() => port.close())
