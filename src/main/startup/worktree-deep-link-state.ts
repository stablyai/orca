import {
  worktreeDeepLinkFromArguments,
  type WorktreeDeepLink
} from '../../shared/worktree-deep-link'

export class WorktreeDeepLinkState {
  private pendingDeepLink: WorktreeDeepLink | null = null

  capture(argv: readonly string[], publish?: (link: WorktreeDeepLink) => boolean | void): boolean {
    const link = worktreeDeepLinkFromArguments(argv)
    if (!link) {
      return false
    }
    this.pendingDeepLink = link
    if (publish?.(link)) {
      this.pendingDeepLink = null
    }
    return true
  }

  consume(): WorktreeDeepLink | null {
    const link = this.pendingDeepLink
    this.pendingDeepLink = null
    return link
  }
}
