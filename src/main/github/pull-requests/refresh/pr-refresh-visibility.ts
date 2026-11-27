import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import {
  aliasFromCandidate,
  refreshKey,
  sameAliasRequestIdentity
} from './pr-refresh-candidate-policy'
import { prRefreshRenderers } from './pr-refresh-renderer-port'

type VisiblePRAliases = {
  rows: Map<string, GitHubPRRefreshCandidate>
  latest: GitHubPRRefreshCandidate
  selected: boolean
}

/** Which rows windows show. A key's demand ends when the last window stops showing it, whether a
 *  report drops it, the window clears or closes, or its workspace is removed; `demandEnded` hears
 *  it then, before that evidence is gone. */
export class PRRefreshVisibility {
  private readonly visibleByWindow = new Map<
    number,
    { generation: number; candidates: Map<string, VisiblePRAliases> }
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
    const reported = new Map<string, VisiblePRAliases>()
    for (const candidate of candidates) {
      const key = refreshKey(candidate)
      const aliasKey = candidate.worktreeId
        ? `worktree:${candidate.worktreeId}`
        : `cache:${candidate.cacheKey}`
      const prior = existing?.candidates.get(key)?.rows.get(aliasKey)
      if (!prior) {
        exposed.add(key)
      } else if (
        prior &&
        !sameAliasRequestIdentity(aliasFromCandidate(prior), aliasFromCandidate(candidate))
      ) {
        changed.add(key)
      }
      const previous = this.candidate(key, candidate)
      let aliases = reported.get(key)
      if (!aliases) {
        aliases = { rows: new Map(), latest: candidate, selected: false }
        reported.set(key, aliases)
      }
      const current = {
        ...previous,
        ...candidate,
        ...(previous.cachedFetchedAt != null &&
        previous.cachedFetchedAt > (candidate.cachedFetchedAt ?? 0)
          ? this.cachedFields(previous)
          : {}),
        isSelected: candidate.isSelected === true
      }
      aliases.rows.set(aliasKey, current)
      aliases.selected ||= current.isSelected
      if ((current.cachedFetchedAt ?? 0) >= (aliases.latest.cachedFetchedAt ?? 0)) {
        aliases.latest = current
      }
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
      for (const [key, aliases] of window.candidates) {
        let changed = false
        for (const [cacheKey, candidate] of aliases.rows) {
          if (candidate.worktreeId === worktreeId) {
            aliases.rows.delete(cacheKey)
            changed = true
            removed.add(key)
          }
        }
        if (aliases.rows.size === 0) {
          window.candidates.delete(key)
        } else if (changed) {
          aliases.latest = aliases.rows.values().next().value!
          aliases.selected = false
          for (const candidate of aliases.rows.values()) {
            aliases.selected ||= candidate.isSelected === true
            if ((candidate.cachedFetchedAt ?? 0) > (aliases.latest.cachedFetchedAt ?? 0)) {
              aliases.latest = candidate
            }
          }
        }
      }
    }
    removed.forEach((key) => this.endDemand(key))
  }

  /** Every reported candidate, with the window that reported it. */
  *reported(): Generator<[number, GitHubPRRefreshCandidate]> {
    this.prune()
    for (const [windowId, window] of this.visibleByWindow) {
      for (const aliases of window.candidates.values()) {
        for (const candidate of aliases.rows.values()) {
          yield [windowId, candidate]
        }
      }
    }
  }

  has(key: string): boolean {
    return this.shown(key) !== undefined
  }

  /** Whether any window still shows a row of the key that `matches` (the same exact request, from
   *  whichever of its aliases). */
  hasDemand(key: string, matches: (shown: GitHubPRRefreshCandidate) => boolean): boolean {
    return this.shown(key, matches) !== undefined
  }

  /** A currently reported alias of the key, optionally matching an exact request. */
  shown(
    key: string,
    matches: (shown: GitHubPRRefreshCandidate) => boolean = () => true
  ): GitHubPRRefreshCandidate | undefined {
    for (const window of this.visibleByWindow.values()) {
      for (const candidate of window.candidates.get(key)?.rows.values() ?? []) {
        if (matches(candidate)) {
          return candidate
        }
      }
    }
    return undefined
  }

  candidate(key: string, fallback: GitHubPRRefreshCandidate): GitHubPRRefreshCandidate {
    let latest = fallback
    let selected = false
    for (const window of this.visibleByWindow.values()) {
      const aliases = window.candidates.get(key)
      if (!aliases) {
        continue
      }
      selected ||= aliases.selected
      if ((aliases.latest.cachedFetchedAt ?? 0) > (latest.cachedFetchedAt ?? 0)) {
        latest = { ...fallback, ...this.cachedFields(aliases.latest) }
      }
    }
    return { ...latest, isSelected: selected }
  }

  update(candidate: GitHubPRRefreshCandidate): void {
    const key = refreshKey(candidate)
    for (const window of this.visibleByWindow.values()) {
      const aliases = window.candidates.get(key)
      if (!aliases) {
        continue
      }
      for (const [aliasKey, current] of aliases.rows) {
        if ((current.cachedFetchedAt ?? 0) <= (candidate.cachedFetchedAt ?? 0)) {
          aliases.rows.set(aliasKey, { ...current, ...this.cachedFields(candidate) })
        }
      }
      if ((aliases.latest.cachedFetchedAt ?? 0) <= (candidate.cachedFetchedAt ?? 0)) {
        aliases.latest = candidate
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
