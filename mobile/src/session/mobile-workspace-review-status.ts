import { reviewStatusPresentation } from '../../../src/shared/review-status-presentation'
import {
  WorktreeReviewStatusSchema,
  type WorktreeReviewStatus
} from '../../../src/shared/worktree-review-status'
import type { RpcClient } from '../transport/rpc-client'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import {
  cachedWorkspaceReviewSchema,
  renewWorkspaceReview
} from './mobile-workspace-review-operations'

const UNKNOWN_STATUS = reviewStatusPresentation({ state: 'unknown' })

export function createMobileWorkspaceReviewStatus() {
  let snapshot = UNKNOWN_STATUS
  const listeners = new Set<() => void>()
  const publish = (next: typeof snapshot) => {
    if (
      next.glyph === snapshot.glyph &&
      next.tone === snapshot.tone &&
      next.label === snapshot.label
    ) {
      return
    }
    snapshot = next
    listeners.forEach((listener) => listener())
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    reset: () => publish(UNKNOWN_STATUS),
    start: (client: RpcClient, worktreeId: string, supported: boolean) => {
      let disposed = false
      if (!supported) {
        void worktreeCatalogRead
          .request(client, {})
          .then((reply) => {
            if (disposed) {
              return
            }
            const result = worktreeCatalogRead.interpret(reply)
            if (!result.accepted) {
              return
            }
            for (const raw of result.value.worktrees ?? []) {
              const row = cachedWorkspaceReviewSchema.safeParse(raw)
              if (row.success && row.data.worktreeId === worktreeId) {
                const review = row.data.linkedPR
                if (review) {
                  const presentation = reviewStatusPresentation(review)
                  publish({ ...presentation, label: `${presentation.label}, cached status` })
                } else {
                  publish(UNKNOWN_STATUS)
                }
                break
              }
            }
          })
          .catch(() => {})
        return () => {
          disposed = true
        }
      }
      let subscriptionId: string | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      let generation = 0
      let failures = 0
      let latestReview: WorktreeReviewStatus['review'] = null
      let releaseStream = () => {}
      const publishReview = (stale: boolean) => {
        const presentation =
          latestReview === null && stale
            ? UNKNOWN_STATUS
            : reviewStatusPresentation({ ...latestReview, hasReview: latestReview !== null })
        publish(
          latestReview !== null && stale
            ? { ...presentation, label: `${presentation.label}, cached status` }
            : presentation
        )
      }
      const clearTimer = () => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }
      const close = () => {
        generation++
        clearTimer()
        const release = releaseStream
        releaseStream = () => {}
        release()
        subscriptionId = null
      }
      const recover = () => {
        close()
        publishReview(true)
        const delay = [1_000, 5_000, 15_000][failures++] ?? 60_000
        timer = setTimeout(open, delay)
      }
      const scheduleRenewal = (epoch: number, id: string) => {
        clearTimer()
        timer = setTimeout(() => {
          void renewWorkspaceReview
            .request(client, { subscriptionId: id }, { failWhenDisconnected: true })
            .then((reply) => {
              if (disposed || epoch !== generation) {
                return
              }
              const result = renewWorkspaceReview.interpret(reply)
              if (!result.accepted || !result.value.renewed) {
                recover()
              } else {
                failures = 0
                scheduleRenewal(epoch, id)
              }
            })
            .catch(() => {
              if (!disposed && epoch === generation) {
                recover()
              }
            })
        }, 50_000)
      }
      const open = () => {
        const epoch = ++generation
        // Bound silent openers too; every retry still enters the host's shared refresh budget.
        timer = setTimeout(recover, 15_000)
        const unsubscribe = client.subscribe(
          'worktree.review.subscribe',
          { worktree: `id:${worktreeId}` },
          (raw) => {
            if (disposed || epoch !== generation) {
              return
            }
            const parsed = WorktreeReviewStatusSchema.safeParse(raw)
            if (
              raw &&
              typeof raw === 'object' &&
              'type' in raw &&
              (raw.type === 'error' || raw.type === 'end')
            ) {
              recover()
              return
            }
            if (!parsed.success || parsed.data.worktreeId !== worktreeId) {
              return
            }
            const event = parsed.data
            if (subscriptionId !== event.subscriptionId) {
              subscriptionId = event.subscriptionId
              scheduleRenewal(epoch, subscriptionId)
            }
            latestReview = event.review
            const stale = event.stale || Boolean(event.error) || event.fetchedAt === null
            publishReview(stale)
          }
        )
        if (!disposed && epoch === generation) {
          releaseStream = unsubscribe
        } else {
          unsubscribe()
        }
      }
      open()
      return () => {
        disposed = true
        close()
      }
    }
  }
}
