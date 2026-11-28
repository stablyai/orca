import {
  browserScreencastFrameBudgetsEqual,
  mergeBrowserScreencastFrameBudgets
} from '../../../browser/cdp/screencast/browser-screencast-frame-budget'
import type {
  BrowserScreencastFrameBudget,
  BrowserScreencastLane,
  BrowserScreencastLaneViewers,
  BrowserScreencastSession
} from '../../../browser/cdp/screencast/browser-screencast-stream-types'
import { hasScreencastViewportSize } from './browser-screencast-budget'
import type {
  ActiveBrowserScreencastLane,
  ActiveBrowserScreencastPage
} from './browser-screencast-contracts'
import { screencastSubscriberIsGhost } from './browser-screencast-ghost-subscriber-eviction'
import {
  cancelScreencastSubscriberFrameRetry,
  deliverScreencastSubscriberFrame
} from './browser-screencast-subscriber-frame-delivery'

// Each lane is one more encode of every page frame on the host; viewers past the cap share the nearest.
const MAX_SCREENCAST_LANES_PER_PAGE = 3

export function createScreencastLane(
  opened: Promise<BrowserScreencastLane>,
  subscriptionIds: Set<string>,
  appliedBudget: BrowserScreencastFrameBudget
): ActiveBrowserScreencastLane {
  // Joiners await it; a lane nobody joined yet must not report an unhandled rejection.
  opened.catch(() => {})
  return { opened, subscriptionIds, appliedBudget }
}

type ScreencastPageMembers = Pick<
  ActiveBrowserScreencastPage,
  'subscribers' | 'viewportOwnerSubscriptionId' | 'stopping' | 'lanes'
>

/** Fans a lane's frames out to its viewers, and tells the lane when one of their links falls behind. */
export function screencastLaneViewers(
  record: ScreencastPageMembers & Pick<ActiveBrowserScreencastPage, 'session'>,
  viewers: ReadonlySet<string>
): BrowserScreencastLaneViewers {
  const onFrame: BrowserScreencastLaneViewers['onFrame'] = (bytes) => {
    const ghosts: string[] = []
    for (const subscriptionId of viewers) {
      const subscriber = record.subscribers.get(subscriptionId)
      if (!subscriber) {
        continue
      }
      deliverScreencastSubscriberFrame(subscriber, bytes)
      if (screencastSubscriberIsGhost(subscriber.delivery)) {
        ghosts.push(subscriptionId)
      }
    }
    // Finish fan-out before eviction can tear down the shared session.
    for (const subscriptionId of ghosts) {
      if (record.session) {
        leaveScreencastPage(record, subscriptionId, record.session)
      }
    }
    return true
  }
  return {
    onFrame,
    // A held frame waits for frame credit or a backed-up socket.
    isViewerBacklogged: () =>
      Array.from(viewers).some((id) => record.subscribers.get(id)?.pendingFrame != null)
  }
}

/** The lane a joining viewer shares: one at its budget, else a new one, else the nearest at the cap. */
export function joinScreencastLane(
  page: Pick<ActiveBrowserScreencastPage, 'lanes' | 'started'>,
  budget: BrowserScreencastFrameBudget,
  laneViewers: (viewers: ReadonlySet<string>) => BrowserScreencastLaneViewers
): ActiveBrowserScreencastLane {
  const same = page.lanes.find((lane) =>
    browserScreencastFrameBudgetsEqual(lane.appliedBudget, budget)
  )
  if (same) {
    return same
  }
  if (page.lanes.length < MAX_SCREENCAST_LANES_PER_PAGE) {
    const viewers = new Set<string>()
    const lane = createScreencastLane(
      page.started.then((session) => session.openLane(budget, laneViewers(viewers))),
      viewers,
      budget
    )
    page.lanes.push(lane)
    return lane
  }
  // Pace matters most: a desktop on a phone's lane would drop to the phone's frame rate.
  const distance = (lane: ActiveBrowserScreencastLane): [number, number] => [
    Math.abs(lane.appliedBudget.minFrameIntervalMs - budget.minFrameIntervalMs),
    Math.abs(
      lane.appliedBudget.maxWidth * lane.appliedBudget.maxHeight -
        budget.maxWidth * budget.maxHeight
    )
  ]
  return page.lanes.reduce((best, lane) => {
    const [pace, area] = distance(lane)
    const [bestPace, bestArea] = distance(best)
    return pace < bestPace || (pace === bestPace && area < bestArea) ? lane : best
  })
}

export function leaveScreencastPage(
  page: ScreencastPageMembers,
  subscriptionId: string,
  session: BrowserScreencastSession
): void {
  const subscriber = page.subscribers.get(subscriptionId)
  if (!subscriber) {
    return
  }
  page.subscribers.delete(subscriptionId)
  const { lane } = subscriber
  lane.subscriptionIds.delete(subscriptionId)
  cancelScreencastSubscriberFrameRetry(subscriber)
  subscriber.resolveDone()
  if (page.viewportOwnerSubscriptionId === subscriptionId) {
    const fallback = Array.from(page.subscribers.entries()).findLast(([, candidate]) =>
      hasScreencastViewportSize(candidate.viewport)
    )
    page.viewportOwnerSubscriptionId = fallback?.[0] ?? null
    if (fallback) {
      void session.updateViewport(fallback[1].viewport).catch(() => {})
    }
  }
  if (page.subscribers.size === 0) {
    page.stopping = true
    session.stop()
    return
  }
  leaveScreencastLane(page, lane)
}

/** A viewer left a page others still watch: close its lane if empty, else re-merge the lane's budget. */
function leaveScreencastLane(
  page: Pick<ActiveBrowserScreencastPage, 'subscribers' | 'lanes'>,
  lane: ActiveBrowserScreencastLane
): void {
  if (lane.subscriptionIds.size > 0) {
    // Departed viewers must not pin their lane's frame budget.
    void applyScreencastLaneFrameBudget(page, lane).catch(() => {})
    return
  }
  const index = page.lanes.indexOf(lane)
  if (index !== -1) {
    page.lanes.splice(index, 1)
  }
  void lane.opened.then((opened) => opened.stop()).catch(() => {})
}

export async function applyScreencastLaneFrameBudget(
  page: Pick<ActiveBrowserScreencastPage, 'subscribers'>,
  lane: ActiveBrowserScreencastLane
): Promise<void> {
  const merged = mergeBrowserScreencastFrameBudgets(
    Array.from(lane.subscriptionIds, (id) => page.subscribers.get(id)?.budget).filter(
      (budget) => budget !== undefined
    )
  )
  if (!merged || browserScreencastFrameBudgetsEqual(merged, lane.appliedBudget)) {
    return
  }
  lane.appliedBudget = merged
  await (await lane.opened).updateFrameBudget(merged)
}
