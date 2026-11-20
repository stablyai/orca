import { BrowserGuestPriorityIndex } from '../../../shared/browser/guest-lifecycle/browser-guest-priority-index'
import type {
  BrowserGuestIdleDiscardRequest,
  BrowserGuestIdleDiscardToken,
  BrowserGuestVisibilityReport
} from '../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'
import {
  readBrowserMemorySaverPolicy,
  type BrowserMemorySaverGlobalSettings,
  type BrowserMemorySaverPolicy
} from '../../../shared/browser/guest-lifecycle/browser-memory-saver'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { getSystemAwakeClock } from '../../power/awake-clock'
import {
  getSystemPowerState,
  subscribeSystemPowerLifecycle
} from '../../power/system-power-lifecycle'

type Episode = {
  rendererId: number
  guestId: number
  generation: number
  visible: boolean | null
  visibilityKnown: boolean
  revisits: number
  /** Awake-clock time the page went hidden; the deadline follows the live Memory Saver hours. */
  hiddenAt: number | null
  consumed: boolean
  send: (request: BrowserGuestIdleDiscardRequest) => void
}

/** Clock injection keeps policy tests independent of wall time and shared clock heuristics. */
export function createBrowserPageIdleDiscard(sources: {
  now: () => number
  awake: () => boolean
  subscribe: (changed: () => void) => () => void
}) {
  const pages = new Map<string, Episode>()
  // Keyed by hiddenAt: one shared idle offset keeps the order, so changing the hours re-keys nothing.
  const deadlines = new BrowserGuestPriorityIndex<Episode>()
  const pending = new Map<number, { episode: Episode | undefined; retired: boolean }>()
  let policy = readBrowserMemorySaverPolicy(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const index = (pageId: string, episode: Episode): void => {
    if (
      episode.visibilityKnown &&
      episode.visible === false &&
      episode.revisits <= 15 &&
      !episode.consumed &&
      episode.hiddenAt !== null
    ) {
      deadlines.set(pageId, episode, episode.hiddenAt)
    } else {
      deadlines.delete(pageId)
    }
  }
  const schedule = (): void => {
    clearTimeout(timer)
    timer = undefined
    const next = deadlines.peek()
    if (!next || !policy.enabled || !sources.awake() || pending.size >= 4) {
      return
    }
    timer = setTimeout(pump, Math.max(0, next.key + policy.idleMs - sources.now()))
    timer.unref?.()
  }
  const pump = (): void => {
    timer = undefined
    if (policy.enabled && sources.awake()) {
      // Acknowledgments schedule another bounded batch, never a whole-inventory sweep.
      for (let count = 0; count < 4 && pending.size < 4; count++) {
        const next = deadlines.peek()
        if (!next || next.key + policy.idleMs > sources.now()) {
          break
        }
        deadlines.pop()
        const episode = next.entry
        episode.consumed = true
        pending.set(episode.guestId, { episode, retired: false })
        try {
          episode.send({
            browserPageId: next.pageId,
            webContentsId: episode.guestId,
            generation: episode.generation,
            visible: false,
            policyToken: { rendererId: episode.rendererId, generation: episode.generation }
          })
        } catch {
          pending.delete(episode.guestId)
        }
      }
    }
    schedule()
  }
  const removeRequest = (episode: Episode): void => {
    const request = pending.get(episode.guestId)
    if (request?.episode === episode && !request.retired) {
      pending.delete(episode.guestId)
    }
  }
  const matches = (
    pageId: string,
    guestId: number,
    token: BrowserGuestIdleDiscardToken
  ): Episode | undefined => {
    const episode = pages.get(pageId)
    return episode &&
      episode.guestId === guestId &&
      episode.rendererId === token.rendererId &&
      episode.generation === token.generation &&
      pending.get(guestId)?.episode === episode &&
      !pending.get(guestId)?.retired
      ? episode
      : undefined
  }
  const unsubscribe = sources.subscribe(schedule)
  return {
    report(
      report: BrowserGuestVisibilityReport,
      rendererId: number,
      send: Episode['send']
    ): boolean {
      const previous = pages.get(report.browserPageId)
      if (
        previous &&
        previous.rendererId === rendererId &&
        previous.guestId === report.webContentsId &&
        report.generation < previous.generation
      ) {
        return false
      }
      if (
        previous?.rendererId === rendererId &&
        previous.guestId === report.webContentsId &&
        previous.generation === report.generation &&
        previous.visible === report.visible
      ) {
        return false
      }
      const visible = report.visible ?? previous?.visible ?? null
      const sameVisibility = previous?.visible === visible
      if (previous) {
        removeRequest(previous)
      }
      const episode: Episode = {
        rendererId,
        guestId: report.webContentsId,
        generation: report.generation,
        visible,
        visibilityKnown: report.visible !== null,
        revisits:
          (previous?.revisits ?? 0) +
          (previous && previous.visible === false && visible === true ? 1 : 0),
        hiddenAt: sameVisibility
          ? (previous?.hiddenAt ?? null)
          : visible === false
            ? sources.now()
            : null,
        consumed: sameVisibility && previous?.consumed === true,
        send
      }
      pages.set(report.browserPageId, episode)
      index(report.browserPageId, episode)
      schedule()
      return true
    },
    admit(pageId: string, guestId: number, token: BrowserGuestIdleDiscardToken): boolean {
      const episode = matches(pageId, guestId, token)
      if (
        !episode ||
        !episode.visibilityKnown ||
        episode.visible !== false ||
        episode.revisits > 15 ||
        episode.hiddenAt === null
      ) {
        return false
      }
      if (!policy.enabled || !sources.awake() || sources.now() < episode.hiddenAt + policy.idleMs) {
        removeRequest(episode)
        episode.consumed = false
        index(pageId, episode)
        schedule()
        return false
      }
      return true
    },
    refuse(pageId: string, guestId: number, token: BrowserGuestIdleDiscardToken): void {
      const episode = matches(pageId, guestId, token)
      if (episode) {
        removeRequest(episode)
        schedule()
      }
    },
    retired(pageId: string, guestId: number): void {
      const episode = pages.get(pageId)
      if (episode) {
        deadlines.delete(pageId)
        episode.consumed = true
      }
      pending.set(guestId, { episode, retired: true })
      schedule()
    },
    destroyed(pageId: string, guestId: number): void {
      pending.delete(guestId)
      const episode = pages.get(pageId)
      if (episode?.guestId === guestId) {
        episode.visibilityKnown = false
        deadlines.delete(pageId)
      }
      schedule()
    },
    close(pageId: string): void {
      const episode = pages.get(pageId)
      if (episode) {
        removeRequest(episode)
      }
      pages.delete(pageId)
      deadlines.delete(pageId)
      schedule()
    },
    /** Pages Memory Saver would free: hidden this long on its own awake clock, and passing the
     *  same protection check its discard admission runs. */
    countHiddenLoadedPages(hiddenForMs: number, canFree: (pageId: string) => boolean): number {
      const cutoff = sources.now() - hiddenForMs
      let count = 0
      for (const [pageId, episode] of pages) {
        if (
          episode.visibilityKnown &&
          episode.visible === false &&
          episode.revisits <= 15 &&
          !episode.consumed &&
          episode.hiddenAt !== null &&
          episode.hiddenAt <= cutoff &&
          canFree(pageId)
        ) {
          count += 1
        }
      }
      return count
    },
    /** Live setting changes move every waiting deadline at once; already freed pages stay freed. */
    configure(next: BrowserMemorySaverPolicy): void {
      policy = next
      schedule()
    },
    dispose(): void {
      unsubscribe()
      clearTimeout(timer)
      pages.clear()
      deadlines.clear()
      pending.clear()
    }
  }
}

let scheduler: ReturnType<typeof createBrowserPageIdleDiscard> | undefined
export function getBrowserPageIdleDiscard(): ReturnType<typeof createBrowserPageIdleDiscard> {
  return (scheduler ??= createBrowserPageIdleDiscard({
    now: () => getSystemAwakeClock().now(),
    awake: () => getSystemPowerState() === 'awake',
    subscribe: (changed) => {
      getSystemAwakeClock()
      return subscribeSystemPowerLifecycle({ onSuspend: changed, onResume: changed })
    }
  }))
}

export type BrowserMemorySaverSettingsSource = {
  getSettings: () => BrowserMemorySaverGlobalSettings | undefined
  onSettingsChanged?: (listener: (updates: Partial<GlobalSettings>) => void) => () => void
}

let stopMemorySaverSync: (() => void) | undefined
/** Applies Settings > Browser > Memory Saver now and on every change, without a restart. */
export function syncBrowserMemorySaverPolicy(store: BrowserMemorySaverSettingsSource): void {
  stopMemorySaverSync?.()
  const apply = (): void =>
    getBrowserPageIdleDiscard().configure(readBrowserMemorySaverPolicy(store.getSettings()))
  apply()
  stopMemorySaverSync = store.onSettingsChanged?.((updates) => {
    if ('browserGuestWorktreeRetentionBudget' in updates || 'browserMemorySaverHours' in updates) {
      apply()
    }
  })
}
