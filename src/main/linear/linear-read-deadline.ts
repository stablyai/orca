import type { LinearClient } from '@linear/sdk'
import { createSignalBoundLinearClient, type LinearClientForWorkspace } from './client'
import { acquire, release } from './linear-request-concurrency'

export type LinearDeadlineRead<T> =
  | { completed: true; value: T }
  | { completed: false; deadlineReached: true }

export async function readLinearBeforeDeadline<T>(
  entry: LinearClientForWorkspace,
  deadline: number,
  read: (client: LinearClient) => Promise<T>
): Promise<LinearDeadlineRead<T>> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    return { completed: false, deadlineReached: true }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), remaining)
  timeout.unref?.()
  const deadlineReached = new Promise<false>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(false), { once: true })
  })
  const permit = acquire().then(() => {
    if (controller.signal.aborted) {
      release()
      return false
    }
    return true
  })

  try {
    const acquired = await Promise.race([permit, deadlineReached])
    if (!acquired) {
      return { completed: false, deadlineReached: true }
    }

    try {
      const completed = await Promise.race([
        read(createSignalBoundLinearClient(entry, controller.signal)).then((value) => ({
          completed: true as const,
          value
        })),
        deadlineReached.then(() => ({ completed: false as const, deadlineReached: true as const }))
      ])
      return completed
    } catch (error) {
      if (controller.signal.aborted) {
        return { completed: false, deadlineReached: true }
      }
      throw error
    } finally {
      release()
    }
  } finally {
    clearTimeout(timeout)
  }
}
