import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FEATURE_WALL_FIRST_AGENT_TOUR_DELAY_MS,
  registerFeatureWallFirstAgentTour
} from './first-agent-tour'
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
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the feature tour nudge shortly after the first agent starts', () => {
    vi.useFakeTimers()
    const source = createStatsSource()
    const window = createWindow()

    registerFeatureWallFirstAgentTour({
      stats: source.stats,
      getWindow: () => window
    })
    source.emit(1)

    expect(window.webContents.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(FEATURE_WALL_FIRST_AGENT_TOUR_DELAY_MS - 1)
    expect(window.webContents.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(window.webContents.send).toHaveBeenCalledWith('ui:showFeatureTourNudge')
  })

  it('does not open for later agent starts or destroyed windows', () => {
    vi.useFakeTimers()
    const source = createStatsSource()
    const window = createWindow()
    registerFeatureWallFirstAgentTour({
      stats: source.stats,
      getWindow: () => window
    })

    source.emit(2)
    vi.advanceTimersByTime(FEATURE_WALL_FIRST_AGENT_TOUR_DELAY_MS)
    window.isDestroyed.mockReturnValue(true)
    source.emit(1)
    vi.advanceTimersByTime(FEATURE_WALL_FIRST_AGENT_TOUR_DELAY_MS)

    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  it('disposes the stats listener and pending tour timer', () => {
    vi.useFakeTimers()
    const source = createStatsSource()
    const window = createWindow()
    const dispose = registerFeatureWallFirstAgentTour({
      stats: source.stats,
      getWindow: () => window
    })

    source.emit(1)
    dispose()
    vi.advanceTimersByTime(FEATURE_WALL_FIRST_AGENT_TOUR_DELAY_MS)
    source.emit(1)

    expect(source.dispose).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).not.toHaveBeenCalled()
  })
})
