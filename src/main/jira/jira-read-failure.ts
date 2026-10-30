import type { JiraClientForSite } from './authenticated-request'
import type { JiraSiteSelection } from '../../shared/jira/jira-types'

export type JiraIssueSearchFailure = {
  error: unknown
  auth: boolean
}

/** Bound a fully consumed read by caller cancellation and a deadline, then retire its signal. */
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
    controller.abort()
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
  // Omitted selections can resolve to persisted all-sites; apply the same resilient fan-out policy.
  return selection !== 'all' && entryCount <= 1
}

export function requireStrictJiraSite(
  entries: JiraClientForSite[],
  siteId: string | null | undefined,
  strict: boolean
): void {
  if (
    strict &&
    (!siteId || siteId === 'all' || entries.length !== 1 || entries[0].site.id !== siteId)
  ) {
    throw new Error('Verified Jira reads require one connected site ID.')
  }
}
