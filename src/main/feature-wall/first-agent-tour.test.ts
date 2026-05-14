import { describe, expect, it, vi } from 'vitest'
import { registerFeatureWallFirstAgentTour } from './first-agent-tour'
import type { StatsCollector } from '../stats/collector'

function createStatsSource() {
  let listener: ((totalAgentsSpawned: number) => void) | null = null
  const dispose = vi.fn(() => {
    listener = null
  })
  const stats = {
    onAgentStarted: vi.fn((nextListener: (totalAgentsSpawned: number) => void) => {
      listener = nextListener
      return dispose
    })
  } satisfies Pick<StatsCollector, 'onAgentStarted'>

  return {
    stats,
    dispose,
    emit: (totalAgentsSpawned: number) => listener?.(totalAgentsSpawned)
  }
}

function createWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn()
    }
  }
}

describe('registerFeatureWallFirstAgentTour', () => {
  it('opens the feature tour when the first agent starts', () => {
    const source = createStatsSource()
    const window = createWindow()

    registerFeatureWallFirstAgentTour({
      stats: source.stats,
      getWindow: () => window
    })
    source.emit(1)

    expect(window.webContents.send).toHaveBeenCalledWith('ui:openFeatureTour')
  })

  it('does not open for later agent starts or destroyed windows', () => {
    const source = createStatsSource()
    const window = createWindow()
    registerFeatureWallFirstAgentTour({
      stats: source.stats,
      getWindow: () => window
    })

    source.emit(2)
    window.isDestroyed.mockReturnValue(true)
    source.emit(1)

    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  it('returns the stats listener disposer', () => {
    const source = createStatsSource()
    const dispose = registerFeatureWallFirstAgentTour({
      stats: source.stats,
      getWindow: () => createWindow()
    })

    dispose()
    source.emit(1)

    expect(source.dispose).toHaveBeenCalledTimes(1)
  })
})
