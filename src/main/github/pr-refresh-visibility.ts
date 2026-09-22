import { webContents } from 'electron'
import type { GitHubPRRefreshCandidate } from '../../shared/github/pull-request-refresh-types'
import { refreshKey } from './pr-refresh-candidate-policy'

export class PRRefreshVisibility {
  private readonly visibleByWindow = new Map<number, { generation: number; keys: Set<string> }>()

  get windowCount(): number {
    return this.visibleByWindow.size
  }

  clearWindow(windowId: number): boolean {
    return this.visibleByWindow.delete(windowId)
  }

  report(candidates: GitHubPRRefreshCandidate[], generation: number, windowId: number): boolean {
    const existing = this.visibleByWindow.get(windowId)
    if (existing && generation < existing.generation) {
      return false
    }
    this.visibleByWindow.set(windowId, { generation, keys: new Set(candidates.map(refreshKey)) })
    return true
  }

  has(key: string): boolean {
    const liveWindowIds = new Set(
      webContents
        .getAllWebContents()
        .filter((contents) => !contents.isDestroyed())
        .map((contents) => contents.id)
    )
    for (const windowId of Array.from(this.visibleByWindow.keys())) {
      if (!liveWindowIds.has(windowId)) {
        this.visibleByWindow.delete(windowId)
      }
    }
    for (const visible of this.visibleByWindow.values()) {
      if (visible.keys.has(key)) {
        return true
      }
    }
    return false
  }
}
