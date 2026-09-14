import type { JiraSiteSelection } from '../../shared/jira-types'

export type JiraIssueSearchFailure = {
  error: unknown
  auth: boolean
}

/** Run against one signal that trips on the caller's abort or the request deadline. */
export async function withJiraDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  run: (deadlineSignal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) {
    controller.abort()
  }
  const timer = setTimeout(abort, timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

export function settleJiraSummaryRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('Jira summary lookup aborted'))
  }
  return new Promise((resolve, reject) => {
    const handleAbort = (): void => {
      cleanup()
      reject(new Error('Jira summary lookup aborted'))
    }
    const cleanup = (): void => signal.removeEventListener('abort', handleAbort)
    signal.addEventListener('abort', handleAbort, { once: true })
    void read.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
  })
}

export function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return null
  }
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

export function toIssueSearchFailureError(error: unknown): unknown {
  const status = getErrorStatus(error)
  if (
    status === null ||
    !(error instanceof Error) ||
    error.message.startsWith(`Error ${status}:`)
  ) {
    return error
  }
  return new Error(`Error ${status}: ${error.message}`)
}

export function shouldSurfaceSiteFailure(
  selection: JiraSiteSelection | null | undefined,
  entryCount: number
): boolean {
  // getClients can resolve an omitted selection to the persisted 'all' choice;
  // multi-entry reads need the same resilient fan-out policy as explicit 'all'.
  return selection !== 'all' && entryCount <= 1
}
