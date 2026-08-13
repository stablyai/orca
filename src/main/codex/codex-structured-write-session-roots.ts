import { snapshotLinkedWorktreeRoot } from './codex-structured-write-manifest'

export class CodexStructuredWriteSessionRoots {
  private readonly roots = new Map<string, string>()
  private readonly identities = new Map<string, string>()

  async bind(sessionId: string, input: string, revokeBoundSession: () => void): Promise<void> {
    if (this.roots.has(sessionId)) {
      revokeBoundSession()
    }
    const worktree = await snapshotLinkedWorktreeRoot(input)
    this.roots.set(sessionId, worktree.root)
    this.identities.set(sessionId, worktree.identity)
  }

  requireRoot(sessionId: string): string {
    const root = this.roots.get(sessionId)
    if (!root) {
      throw new Error(`no host-selected writable worktree for ${sessionId}`)
    }
    return root
  }

  requireIdentity(sessionId: string): string {
    const identity = this.identities.get(sessionId)
    if (!identity) {
      throw new Error(`no host-selected writable worktree identity for ${sessionId}`)
    }
    return identity
  }

  isBoundTo(sessionId: string, root: string): boolean {
    return this.roots.get(sessionId) === root
  }

  delete(sessionId: string): void {
    this.roots.delete(sessionId)
    this.identities.delete(sessionId)
  }
}
