import { mergeDiffCommentMutation } from '../../../src/shared/diff-comment-mutation'
import type { DiffComment } from '../../../src/shared/diff-comment-types'

type PendingSave = { base: DiffComment[]; next: DiffComment[] }

/** One workspace's notes: the host's last list, the phone's unanswered saves and their request queue. */
export type ReviewNotesSync = {
  active: boolean
  host: DiffComment[]
  pending: PendingSave[]
  queue: Promise<unknown>
}

export function createReviewNotesSync(): ReviewNotesSync {
  return { active: true, host: [], pending: [], queue: Promise.resolve() }
}

// What the phone shows: the host's list with every unanswered phone save replayed on top.
export function reviewNotesView(sync: ReviewNotesSync): DiffComment[] {
  return sync.pending.reduce(
    (list, save) => mergeDiffCommentMutation(save.base, list, save.next),
    sync.host
  )
}

// Why: one request at a time, so each reply already holds this phone's earlier saves.
export function enqueueReviewNotesRequest<T>(
  sync: ReviewNotesSync,
  run: () => Promise<T>
): Promise<T> {
  const result = sync.queue.then(run)
  sync.queue = result.catch(() => undefined)
  return result
}
