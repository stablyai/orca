import {
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
export { managedWorktreeDirectories } from '../../shared/worktree/ownership'

export class ScopePathSet {
  private readonly seen = new Set<string>()
  private readonly entries: string[] = []

  add(value: string | null | undefined): void {
    const trimmed = value?.trim()
    if (!trimmed || !isRuntimePathAbsolute(trimmed)) {
      return
    }
    const key = normalizeRuntimePathForComparison(trimmed)
    if (this.seen.has(key)) {
      return
    }
    this.seen.add(key)
    this.entries.push(trimmed)
  }

  // Prefix matching makes contained paths redundant SQL ranges.
  folded(): string[] {
    return this.entries.filter(
      (candidate) =>
        !this.entries.some((other) => other !== candidate && isPathInsideOrEqual(other, candidate))
    )
  }
}
