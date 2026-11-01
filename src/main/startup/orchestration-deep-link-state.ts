import {
  orchestrationDeepLinkFromArguments,
  type OrchestrationDeepLink
} from '../../shared/orchestration-deep-link'

export class OrchestrationDeepLinkState {
  private pendingDeepLink: OrchestrationDeepLink | null = null

  capture(
    argv: readonly string[],
    publish?: (link: OrchestrationDeepLink) => boolean | void
  ): boolean {
    const link = orchestrationDeepLinkFromArguments(argv)
    if (!link) {
      return false
    }
    this.pendingDeepLink = link
    // Only clear once `publish` confirms delivery; a later consume() would otherwise
    // re-fire the same link on a renderer reload even though it was already handled.
    if (publish?.(link)) {
      this.pendingDeepLink = null
    }
    return true
  }

  consume(): OrchestrationDeepLink | null {
    const link = this.pendingDeepLink
    this.pendingDeepLink = null
    return link
  }
}
