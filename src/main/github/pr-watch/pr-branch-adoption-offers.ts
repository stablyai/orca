// Offers each saved publication of a PR to its chat's checkout on every read of that PR, so one
// that fails is retried and one followed or overtaken by the checkout ends.

import type { PRInfo } from '../../../shared/github/pull-request-types'
import {
  deletePRBranchAdoption,
  readPRBranchAdoptions,
  type PRBranchAdoption
} from './pr-branch-adoption-intents'
import type { ParsedPRKey, PRWatchServiceDeps } from './pr-watch-types'

export class PRBranchAdoptionOffers {
  private readonly adopting = new Set<string>()

  constructor(
    private readonly deps: Pick<
      PRWatchServiceDeps,
      'database' | 'adoptPublishedBranch' | 'logger'
    > & {
      stopped: () => boolean
    }
  ) {}

  /** `after`: publications older than this are no longer offered. */
  offer(key: ParsedPRKey, pr: PRInfo, after: number): void {
    const { headRefName: branch, headSha, headRepo } = pr
    if (!branch || !headSha || (pr.state !== 'open' && pr.state !== 'draft')) {
      return
    }
    for (const adoption of readPRBranchAdoptions(this.deps.database.db, key, after)) {
      const id = `${adoption.chatId}\0${adoption.createdAt}`
      const target = adoption.remoteUrl
        ? { remoteUrl: adoption.remoteUrl }
        : headRepo && { headRepo }
      if (!target || this.adopting.has(id)) {
        continue
      }
      this.adopting.add(id)
      const published = { branch, headSha, pr: key, checkoutBranch: adoption.checkoutBranch }
      this.deps
        .adoptPublishedBranch(adoption.chatId, { ...published, ...target })
        .then(
          () => this.end(adoption),
          (error: unknown) =>
            this.deps.logger.warn('adopting a published branch failed', {
              scope: 'pr-watch',
              error
            })
        )
        .finally(() => this.adopting.delete(id))
    }
  }

  private end(adoption: PRBranchAdoption): void {
    if (!this.deps.stopped()) {
      this.deps.database.transaction((db) => deletePRBranchAdoption(db, adoption))
    }
  }
}
