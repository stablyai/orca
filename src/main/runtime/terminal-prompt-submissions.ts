import { createHash } from 'node:crypto'
import { sharedPromiseSettlementWaiters } from '../../shared/promise-settlement-waiters'
import type {
  RuntimeTerminalPromptSubmission,
  RuntimeTerminalSend
} from '../../shared/runtime-terminal-send-contract'

const COMPLETED_RETENTION_MS = 5 * 60_000
const MAX_SUBMISSIONS = 256
const MAX_PENDING_BYTES = 64 * 1024 * 1024
const WAIT_TIMEOUT = 'terminal_prompt_wait_timeout'

type Submission = {
  fingerprint: string
  receipt: RuntimeTerminalPromptSubmission
  completion: Promise<void>
  completedAt?: number
}

export class TerminalPromptSubmissions {
  private readonly submissions = new Map<string, Submission>()
  private pendingBytes = 0

  enqueue(
    handle: string,
    requestId: string,
    prompt: string,
    submit: (inputWritten: () => void) => Promise<RuntimeTerminalSend>
  ): RuntimeTerminalPromptSubmission {
    this.prune()
    const key = `${handle}\0${requestId}`
    const fingerprint = createHash('sha256').update(prompt).digest('hex')
    const existing = this.submissions.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error('terminal_prompt_request_conflict')
      }
      return existing.receipt
    }
    const bytes = Buffer.byteLength(prompt)
    if (this.submissions.size >= MAX_SUBMISSIONS || this.pendingBytes + bytes > MAX_PENDING_BYTES) {
      throw new Error('terminal_prompt_queue_full')
    }
    let inputWritten = false
    const submission: Submission = {
      fingerprint,
      receipt: { requestId, status: 'pending' },
      completion: Promise.resolve()
    }
    this.pendingBytes += bytes
    this.submissions.set(key, submission)
    submission.completion = Promise.resolve()
      .then(() =>
        submit(() => {
          inputWritten = true
        })
      )
      .then(
        (send) => {
          submission.receipt = { requestId, status: 'submitted', send }
        },
        (error: unknown) => {
          const code = error instanceof Error ? error.message : ''
          const reason =
            code === 'agent_prompt_blocked' || code === 'terminal_guard_permission'
              ? 'permission'
              : code === 'terminal_guard_no_agent'
                ? 'no-agent'
                : [
                      'terminal_not_writable',
                      'terminal_guard_not_writable',
                      'terminal_handle_stale',
                      'terminal_gone',
                      'terminal_exited'
                    ].includes(code)
                  ? 'not-writable'
                  : 'submission-failed'
          submission.receipt = { requestId, status: 'failed', reason, inputWritten }
        }
      )
      .finally(() => {
        this.pendingBytes -= bytes
        submission.completedAt = Date.now()
      })
    return submission.receipt
  }

  async wait(
    handle: string,
    requestId: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<RuntimeTerminalPromptSubmission> {
    this.prune()
    const submission = this.submissions.get(`${handle}\0${requestId}`)
    if (!submission) {
      throw new Error('terminal_prompt_submission_not_found')
    }
    if (submission.receipt.status === 'pending' && timeoutMs > 0) {
      try {
        await sharedPromiseSettlementWaiters(submission.completion).wait({
          timeoutMs,
          signal,
          createTimeoutError: () => new Error(WAIT_TIMEOUT)
        })
      } catch (error) {
        if (!(error instanceof Error) || error.message !== WAIT_TIMEOUT) {
          throw error
        }
      }
    }
    return submission.receipt
  }

  private prune(): void {
    const expiredBefore = Date.now() - COMPLETED_RETENTION_MS
    for (const [key, submission] of this.submissions) {
      if (submission.completedAt !== undefined && submission.completedAt <= expiredBefore) {
        this.submissions.delete(key)
      }
    }
  }
}
