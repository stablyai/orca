import type { BrowserWindow } from 'electron'
import type { StatsCollector } from '../stats/collector'

type FeatureWallWindow = Pick<BrowserWindow, 'isDestroyed'> & {
  webContents: Pick<BrowserWindow['webContents'], 'send'>
}

export function registerFeatureWallFirstAgentTour(args: {
  stats: Pick<StatsCollector, 'onAgentStarted'>
  getWindow: () => FeatureWallWindow | null
}): () => void {
  return args.stats.onAgentStarted((totalAgentsSpawned) => {
    if (totalAgentsSpawned !== 1) {
      return
    }

    const window = args.getWindow()
    if (!window || window.isDestroyed()) {
      return
    }

    // Why: the feature tour is the post-first-agent education moment; older
    // users with existing stats skip it because their total is already > 1.
    window.webContents.send('ui:openFeatureTour')
  })
}
