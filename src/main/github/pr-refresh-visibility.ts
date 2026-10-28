import { getRuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import type { GitHubPRRefreshCandidate } from '../../shared/github/pull-request-refresh-types'
import { refreshKey } from './pr-refresh-candidate-policy'

export class PRRefreshVisibility {
  private readonly visibleByWindow = new Map<
    number | string,
    { generation: number; candidates: Map<string, GitHubPRRefreshCandidate> }
  >()

  get windowCount(): number {
    return this.visibleByWindow.size
  }

  clearWindow(windowId: number | string): boolean {
    return this.visibleByWindow.delete(windowId)
  }

  report(
    candidates: GitHubPRRefreshCandidate[],
    generation: number,
    windowId: number | string
  ): boolean {
    this.pruneDestroyedWindows()
    const existing = this.visibleByWindow.get(windowId)
    if (existing && generation < existing.generation) {
      return false
    }
    const reported = new Map<string, GitHubPRRefreshCandidate>()
    for (const candidate of candidates) {
      const key = refreshKey(candidate)
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
    return true
  }

  ownerHas(ownerId: number | string, key: string): boolean {
    return this.visibleByWindow.get(ownerId)?.candidates.has(key) ?? false
  }

  has(key: string): boolean {
    this.pruneDestroyedWindows()
    return Array.from(this.visibleByWindow.values()).some((window) => window.candidates.has(key))
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
      if (
        candidate.cachedFetchedAt != null &&
        candidate.cachedFetchedAt >= (latest.cachedFetchedAt ?? 0)
      ) {
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

  private pruneDestroyedWindows(): void {
    for (const windowId of this.visibleByWindow.keys()) {
      if (typeof windowId !== 'number') {
        continue
      }
      if (!getRuntimeDesktopSurface().isRendererAlive?.(windowId)) {
        this.visibleByWindow.delete(windowId)
      }
    }
  }
}
