import type {
  WorkspaceServerFrame,
  WorkspaceServerSnapshot
} from '../../shared/workspace-server-process'

export class WorkspaceServerSubscriptions {
  private readonly listeners = new Map<string, Set<(frame: WorkspaceServerFrame) => void>>()
  has(worktreeId: string): boolean {
    return Boolean(this.listeners.get(worktreeId)?.size)
  }
  clear(): void {
    this.listeners.clear()
  }
  emit(worktreeId: string, frame: WorkspaceServerFrame): void {
    for (const listener of this.listeners.get(worktreeId) ?? []) {
      try {
        listener(frame)
      } catch {
        this.listeners.get(worktreeId)?.delete(listener)
      }
    }
  }
  subscribe(
    worktreeId: string,
    listener: (frame: WorkspaceServerFrame) => void,
    runs: WorkspaceServerSnapshot[]
  ): () => void {
    let listeners = this.listeners.get(worktreeId)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(worktreeId, listeners)
    }
    listeners.add(listener)
    listener({
      type: 'snapshot',
      runs
    })
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        this.listeners.delete(worktreeId)
      }
    }
  }
}
