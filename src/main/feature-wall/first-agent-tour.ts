import type { BrowserWindow } from 'electron'
import type { StatsCollector } from '../stats/collector'

type FeatureWallWindow = Pick<BrowserWindow, 'isDestroyed'> & {
  webContents: Pick<BrowserWindow['webContents'], 'send'>
}

export const FEATURE_WALL_FIRST_AGENT_TOUR_DELAY_MS = 1_500

export function registerFeatureWallFirstAgentTour(args: {
  stats: Pick<StatsCollector, 'onAgentStarted'>
  getWindow: () => FeatureWallWindow | null
}): () => void {
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let didScheduleTour = false

  const disposeStatsListener = args.stats.onAgentStarted((totalAgentsSpawned) => {
    if (totalAgentsSpawned !== 1 || didScheduleTour) {
      return
    }

    didScheduleTour = true

    // Why: let the first agent launch visibly land before the education modal
    // takes focus; older users skip this because their total is already > 1.
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      const window = args.getWindow()
      if (!window || window.isDestroyed()) {
        return
      }
      window.webContents.send('ui:openFeatureTour')
    }, FEATURE_WALL_FIRST_AGENT_TOUR_DELAY_MS)
  })

  return () => {
    disposeStatsListener()
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
  }
}
