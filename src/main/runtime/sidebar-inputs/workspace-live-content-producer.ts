import {
  workspaceLiveContentEqual,
  type WorkspaceLiveContent
} from '../../../shared/sidebar-list/workspace-live-content'
import { ProducerRevision } from './producer-revision'

/**
 * Per-workspace live terminal content, re-read on the same per-workspace funnel the activity
 * producer refreshes on, so it moves with every PTY bind, exit and verdict.
 */
export class WorkspaceLiveContentProducer {
  readonly revision = new ProducerRevision()
  private readonly content = new Map<string, WorkspaceLiveContent>()

  constructor(private readonly read: (worktreeId: string) => WorkspaceLiveContent) {}

  refresh(worktreeId: string): void {
    const next = this.read(worktreeId)
    const previous = this.content.get(worktreeId)
    const idle = next.liveTerminalCount === 0 && !next.hasAttachedPty
    if (idle ? !previous : previous && workspaceLiveContentEqual(previous, next)) {
      return
    }
    if (idle) {
      this.content.delete(worktreeId)
    } else {
      this.content.set(worktreeId, next)
    }
    this.revision.bump()
  }

  snapshot(): Record<string, WorkspaceLiveContent> {
    return Object.fromEntries(this.content)
  }
}
