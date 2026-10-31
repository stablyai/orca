import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'

export type WorkspaceServerStartPermit = {
  validate: (worktreeId: string) => void
  release: () => void
}

/** Revocable admission spans async selector resolution and command preparation. */
export class WorkspaceServerStartAdmission {
  private readonly removals = new Map<string, number>()
  private readonly pendingStarts = new Set<Set<string>>()
  get pending(): boolean {
    return this.pendingStarts.size > 0
  }
  assertAvailable(worktreeId: string): void {
    if (
      this.removals.has(`workspace:${worktreeId}`) ||
      this.removals.has(`project:${getRepoIdFromWorktreeId(worktreeId)}`)
    ) {
      throw new Error('Workspace removal is in progress.')
    }
  }
  /** Capture before resolving a selector: removal can finish while that resolution is pending. */
  beginStart(): WorkspaceServerStartPermit {
    const revoked = new Set(this.removals.keys())
    this.pendingStarts.add(revoked)
    return {
      validate: (worktreeId) => {
        if (
          !this.pendingStarts.has(revoked) ||
          revoked.has(`workspace:${worktreeId}`) ||
          revoked.has(`project:${getRepoIdFromWorktreeId(worktreeId)}`)
        ) {
          throw new Error('The workspace was removed while starting the server.')
        }
      },
      release: () => {
        this.pendingStarts.delete(revoked)
      }
    }
  }
  beginWorktreeRemoval(worktreeId: string): () => void {
    return this.beginRemoval(`workspace:${worktreeId}`)
  }
  beginProjectRemoval(repoId: string): () => void {
    return this.beginRemoval(`project:${repoId}`)
  }
  private beginRemoval(worktreeId: string): () => void {
    this.removals.set(worktreeId, (this.removals.get(worktreeId) ?? 0) + 1)
    for (const revoked of this.pendingStarts) {
      revoked.add(worktreeId)
    }
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const remaining = (this.removals.get(worktreeId) ?? 1) - 1
      if (remaining) {
        this.removals.set(worktreeId, remaining)
      } else {
        this.removals.delete(worktreeId)
      }
    }
  }
}
