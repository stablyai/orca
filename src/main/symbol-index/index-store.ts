import type { SymbolDef } from '../../shared/symbol-index'

type WorktreeIndex = {
  /** absPath -> defs declared in that file */
  byFile: Map<string, SymbolDef[]>
  /** symbol name -> set of absPaths that declare it (for fast lookup) */
  byName: Map<string, Set<string>>
}

export class SymbolIndexStore {
  private worktrees = new Map<string, WorktreeIndex>()

  private ensure(worktreeId: string): WorktreeIndex {
    let wt = this.worktrees.get(worktreeId)
    if (!wt) {
      wt = { byFile: new Map(), byName: new Map() }
      this.worktrees.set(worktreeId, wt)
    }
    return wt
  }

  setFileSymbols(worktreeId: string, absPath: string, defs: SymbolDef[]): void {
    const wt = this.ensure(worktreeId)
    this.detachFile(wt, absPath)
    wt.byFile.set(absPath, defs)
    for (const d of defs) {
      let set = wt.byName.get(d.name)
      if (!set) {
        set = new Set()
        wt.byName.set(d.name, set)
      }
      set.add(absPath)
    }
  }

  removeFile(worktreeId: string, absPath: string): void {
    const wt = this.worktrees.get(worktreeId)
    if (!wt) {
      return
    }
    this.detachFile(wt, absPath)
    wt.byFile.delete(absPath)
  }

  private detachFile(wt: WorktreeIndex, absPath: string): void {
    const prev = wt.byFile.get(absPath)
    if (!prev) {
      return
    }
    for (const d of prev) {
      const set = wt.byName.get(d.name)
      if (!set) {
        continue
      }
      set.delete(absPath)
      if (set.size === 0) {
        wt.byName.delete(d.name)
      }
    }
  }

  find(worktreeId: string, name: string): SymbolDef[] {
    const wt = this.worktrees.get(worktreeId)
    if (!wt) {
      return []
    }
    const paths = wt.byName.get(name)
    if (!paths) {
      return []
    }
    const out: SymbolDef[] = []
    for (const p of paths) {
      for (const d of wt.byFile.get(p) ?? []) {
        if (d.name === name) {
          out.push(d)
        }
      }
    }
    out.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1))
    return out
  }

  hasWorktree(worktreeId: string): boolean {
    return this.worktrees.has(worktreeId)
  }

  clearWorktree(worktreeId: string): void {
    this.worktrees.delete(worktreeId)
  }

  fileCount(worktreeId: string): number {
    return this.worktrees.get(worktreeId)?.byFile.size ?? 0
  }
}
