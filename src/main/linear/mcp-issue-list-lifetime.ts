import { acquire, release, reserveLinearListing } from './linear-request-concurrency'
import { registerLinearAccountRead } from './linear-account-read-lifetime'
import { LinearAgentAccessError, linearError } from './issue-context-errors'
import { getStatus } from './client'
import { clearToken } from './linear-token-store'

export class IssueListLifetime {
  private readonly releaseReservation: () => void
  private pending = 0
  private finished = false
  readonly expiredAccounts = new Set<string>()
  readonly deadline: number

  constructor(
    readonly signal?: AbortSignal,
    budgetMs = 20_000
  ) {
    const reservation = reserveLinearListing()
    if (!reservation) {
      throw linearError('linear_list_capacity', 'Linear listing capacity is busy; retry later.')
    }
    this.releaseReservation = reservation
    this.deadline = Date.now() + budgetMs
  }

  get cleanupPending(): boolean {
    return this.pending > 0
  }

  finish(): void {
    this.finished = true
    this.maybeRelease()
  }

  private maybeRelease(): void {
    if (this.finished && this.pending === 0) {
      this.releaseReservation()
    }
  }

  async read<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.pending > 0) {
      throw linearError('linear_list_capacity', 'Previous Linear page cleanup is still pending.')
    }
    this.signal?.throwIfAborted()
    const remaining = this.deadline - Date.now()
    if (remaining <= 0) {
      throw linearError('linear_timeout', 'Linear listing deadline reached.')
    }
    const account = registerLinearAccountRead(workspaceId)
    const timeout = new AbortController()
    const signal = AbortSignal.any([
      account.signal,
      timeout.signal,
      ...(this.signal ? [this.signal] : [])
    ])
    const timer = setTimeout(
      () => timeout.abort(linearError('linear_timeout', 'Linear listing deadline reached.')),
      remaining
    )
    this.pending++
    const settled = (async () => {
      await acquire(signal)
      try {
        signal.throwIfAborted()
        return await operation(signal)
      } catch (error) {
        if (error instanceof LinearAgentAccessError && error.code === 'linear_auth_expired') {
          account.mutateIfCurrent(() => {
            clearToken(workspaceId)
            if (!getStatus().workspaces?.some((w) => w.id === workspaceId)) {
              this.expiredAccounts.add(workspaceId)
            }
          })
        }
        throw error
      } finally {
        release()
      }
    })().finally(() => {
      clearTimeout(timer)
      account.dispose()
      this.pending--
      this.maybeRelease()
    })
    let abort: (() => void) | undefined
    try {
      return await Promise.race([
        settled,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) {
            abort()
          }
        })
      ])
    } finally {
      if (abort) {
        signal.removeEventListener('abort', abort)
      }
    }
  }
}
