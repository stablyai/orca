export class WindowRegistry {
  // Maps windowId → worktreeId
  private windowToWorktree = new Map<number, string>();

  // Maps worktreeId → Set of windowIds
  private worktreeToWindows = new Map<string, Set<number>>();

  register(windowId: number, worktreeId: string): void {
    // If window already exists with different worktree, remove from old mapping
    const existingWorktree = this.windowToWorktree.get(windowId);
    if (existingWorktree && existingWorktree !== worktreeId) {
      const windows = this.worktreeToWindows.get(existingWorktree);
      if (windows) {
        windows.delete(windowId);
        if (windows.size === 0) {
          this.worktreeToWindows.delete(existingWorktree);
        }
      }
    }

    this.windowToWorktree.set(windowId, worktreeId);

    if (!this.worktreeToWindows.has(worktreeId)) {
      this.worktreeToWindows.set(worktreeId, new Set());
    }
    this.worktreeToWindows.get(worktreeId)!.add(windowId);
  }

  deregister(windowId: number): void {
    const worktreeId = this.windowToWorktree.get(windowId);
    if (worktreeId) {
      this.windowToWorktree.delete(windowId);
      const windows = this.worktreeToWindows.get(worktreeId);
      if (windows) {
        windows.delete(windowId);
        if (windows.size === 0) {
          this.worktreeToWindows.delete(worktreeId);
        }
      }
    }
  }

  getWindowByWorktreeId(worktreeId: string): number | undefined {
    const windows = this.worktreeToWindows.get(worktreeId);
    return windows?.size ? Array.from(windows)[0] : undefined;
  }

  getWorktreesByWindowId(windowId: number): string | undefined {
    return this.windowToWorktree.get(windowId);
  }

  getWindowsForWorktree(worktreeId: string): number[] {
    const windows = this.worktreeToWindows.get(worktreeId);
    return windows ? Array.from(windows) : [];
  }

  getAllWindows(): number[] {
    return Array.from(this.windowToWorktree.keys());
  }

  getWindowCount(): number {
    return this.windowToWorktree.size;
  }
}

export default WindowRegistry;
