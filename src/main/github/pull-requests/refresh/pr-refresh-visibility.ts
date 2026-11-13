import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import {
  aliasFromCandidate,
  refreshKey,
  sameAliasRequestIdentity
} from './pr-refresh-candidate-policy'
import { prRefreshRenderers } from './pr-refresh-renderer-port'

/** Which rows windows show. A key's demand ends when the last window stops showing it, whether a
 *  report drops it, the window clears or closes, or its workspace is removed; `demandEnded` hears
 *  it then, before that evidence is gone. */
export class PRRefreshVisibility {
  private readonly visibleByWindow = new Map<
    number,
    { generation: number; candidates: Map<string, GitHubPRRefreshCandidate> }
  >()

  constructor(private readonly demandEnded: (key: string) => void = () => {}) {}

  get windowCount(): number {
    return this.visibleByWindow.size
  }

  clearWindow(windowId: number): boolean {
    const cleared = this.removeWindow(windowId)
    this.prune()
    return cleared
  }

  /** Replaces a window's rows unless the report is older than the last one accepted (null). Returns
   *  the keys no window showed before (`exposed`) and those it shows as another request than
   *  before (`changed`); work only the window's own old and new rows. */
  report(
    candidates: GitHubPRRefreshCandidate[],
    generation: number,
    windowId: number
  ): { exposed: Set<string>; changed: Set<string> } | null {
    this.prune()
    const existing = this.visibleByWindow.get(windowId)
    if (existing && generation < existing.generation) {
      return null
    }
    const exposed = new Set<string>()
    const changed = new Set<string>()
    const reported = new Map<string, GitHubPRRefreshCandidate>()
    for (const candidate of candidates) {
      const key = refreshKey(candidate)
      const shown = existing?.candidates.get(key) ?? this.shown(key)
      if (!shown) {
        exposed.add(key)
      } else if (
        !sameAliasRequestIdentity(aliasFromCandidate(shown), aliasFromCandidate(candidate))
      ) {
        changed.add(key)
      }
      const previous = this.candidate(key, candidate)
      reported.set(key, {
        ...previous,
        ...candidate,
        ...(previous.cachedFetchedAt != null &&
        previous.cachedFetchedAt > (candidate.cachedFetchedAt ?? 0)
          ? this.cachedFields(previous)
          : {}),
        isSelected: candidate.isSelected === true || reported.get(key)?.isSelected === true
      })
    }
    this.visibleByWindow.set(windowId, { generation, candidates: reported })
    for (const key of existing?.candidates.keys() ?? []) {
      if (!reported.has(key)) {
        this.endDemand(key)
      }
    }
    return { exposed, changed }
  }

  /** A removed workspace's rows are no longer shown, whatever its windows reported last. */
  removeWorktree(worktreeId: string): void {
    const removed = new Set<string>()
    for (const window of this.visibleByWindow.values()) {
      for (const [key, candidate] of window.candidates) {
        if (candidate.worktreeId === worktreeId) {
          window.candidates.delete(key)
          removed.add(key)
        }
      }
    }
    removed.forEach((key) => this.endDemand(key))
  }

  /** Every reported candidate, with the window that reported it. */
  *reported(): Generator<[number, GitHubPRRefreshCandidate]> {
    this.prune()
    for (const [windowId, window] of this.visibleByWindow) {
      for (const candidate of window.candidates.values()) {
        yield [windowId, candidate]
      }
    }
  }

  has(key: string): boolean {
    return this.shown(key) !== undefined
  }

  /** Whether any window still shows a row of the key that `matches` (the same exact request, from
   *  whichever of its aliases). */
  hasDemand(key: string, matches: (shown: GitHubPRRefreshCandidate) => boolean): boolean {
    for (const window of this.visibleByWindow.values()) {
      const shown = window.candidates.get(key)
      if (shown && matches(shown)) {
        return true
      }
    }
    return false
  }

  /** The row a window reports for the key. */
  shown(key: string): GitHubPRRefreshCandidate | undefined {
    for (const window of this.visibleByWindow.values()) {
      const candidate = window.candidates.get(key)
      if (candidate) {
        return candidate
      }
    }
    return undefined
  }

  candidate(key: string, fallback: GitHubPRRefreshCandidate): GitHubPRRefreshCandidate {
    let latest = fallback
    let selected = false
    for (const window of this.visibleByWindow.values()) {
      const candidate = window.candidates.get(key)
      if (!candidate) {
        continue
      }
      selected ||= candidate.isSelected === true
      if ((candidate.cachedFetchedAt ?? 0) > (latest.cachedFetchedAt ?? 0)) {
        latest = { ...fallback, ...this.cachedFields(candidate) }
      }
    }
    return { ...latest, isSelected: selected }
  }

  update(candidate: GitHubPRRefreshCandidate): void {
    const key = refreshKey(candidate)
    for (const window of this.visibleByWindow.values()) {
      const current = window.candidates.get(key)
      if (current && (current.cachedFetchedAt ?? 0) <= (candidate.cachedFetchedAt ?? 0)) {
        window.candidates.set(key, { ...current, ...this.cachedFields(candidate) })
      }
    }
  }

  private cachedFields(candidate: GitHubPRRefreshCandidate): Partial<GitHubPRRefreshCandidate> {
    return {
      cachedFetchedAt: candidate.cachedFetchedAt,
      cachedHeadOid: candidate.cachedHeadOid,
      cachedHasPR: candidate.cachedHasPR,
      cachedPRState: candidate.cachedPRState,
      cachedChecksStatus: candidate.cachedChecksStatus,
      cachedMergeable: candidate.cachedMergeable,
      cachedMergeStateStatus: candidate.cachedMergeStateStatus
    }
  }

  /** Drops windows whose renderer is gone, ending their rows' demand. */
  prune(): void {
    for (const windowId of Array.from(this.visibleByWindow.keys())) {
      if (!prRefreshRenderers().isRendererOpen(windowId)) {
        this.removeWindow(windowId)
      }
    }
  }

  private removeWindow(windowId: number): boolean {
    const window = this.visibleByWindow.get(windowId)
    this.visibleByWindow.delete(windowId)
    window?.candidates.forEach((_, key) => this.endDemand(key))
    return window !== undefined
  }

  private endDemand(key: string): void {
    if (!this.has(key)) {
      this.demandEnded(key)
    }
  }
}
