import { describe, expect, it } from 'vitest'
import {
  createRendererUnresponsiveEpisodeMachine,
  shouldSuppressRendererUnresponsive,
  type RendererEpisodeSessionBudget
} from './renderer-unresponsive-episodes'

describe('renderer unresponsive episode machine', () => {
  it('coalesces duplicate notifications and closes with a measured outcome', () => {
    let now = 100
    const machine = createRendererUnresponsiveEpisodeMachine({ now: () => now })
    expect(machine.onUnresponsive()).toEqual({ episodeId: 100, startedAtMs: 100 })
    now = 250
    expect(machine.onUnresponsive()).toBeNull()
    expect(machine.onResponsive()).toEqual({
      episodeId: 100,
      outcome: 'recovered',
      durationMs: 150
    })
  })

  it('shares the five-episode cap across machines in one app session', () => {
    const sessionBudget: RendererEpisodeSessionBudget = { count: 0 }
    const first = createRendererUnresponsiveEpisodeMachine({
      sessionBudget,
      isSuppressed: () => false
    })
    const second = createRendererUnresponsiveEpisodeMachine({
      sessionBudget,
      isSuppressed: () => false
    })
    for (let i = 0; i < 3; i++) {
      expect(first.onUnresponsive(i)).not.toBeNull()
      first.onResponsive(i + 1)
    }
    for (let i = 0; i < 2; i++) {
      expect(second.onUnresponsive(i + 10)).not.toBeNull()
      second.onResponsive(i + 11)
    }
    expect(first.onUnresponsive(99)).toBeNull()
    expect(second.onUnresponsive(100)).toBeNull()
    expect(sessionBudget.count).toBe(5)
  })

  it('closes an open episode as process_gone or abandoned exactly once', () => {
    const gone = createRendererUnresponsiveEpisodeMachine({ isSuppressed: () => false })
    expect(gone.onUnresponsive(10)).not.toBeNull()
    expect(gone.onProcessGone(25)).toEqual({
      episodeId: 10,
      outcome: 'process_gone',
      durationMs: 15
    })
    expect(gone.onAbandoned(30)).toBeNull()

    const abandoned = createRendererUnresponsiveEpisodeMachine({ isSuppressed: () => false })
    expect(abandoned.onUnresponsive(40)).not.toBeNull()
    expect(abandoned.onAbandoned(55)).toEqual({
      episodeId: 40,
      outcome: 'abandoned',
      durationMs: 15
    })
  })

  it('suppresses development and debugger/devtools observations', () => {
    expect(
      shouldSuppressRendererUnresponsive({
        isDev: true,
        isDevToolsOpened: false,
        debuggerAttached: false
      })
    ).toBe(true)
    expect(
      shouldSuppressRendererUnresponsive({
        isDev: false,
        isDevToolsOpened: true,
        debuggerAttached: false
      })
    ).toBe(true)
    expect(
      shouldSuppressRendererUnresponsive({
        isDev: false,
        isDevToolsOpened: false,
        debuggerAttached: true
      })
    ).toBe(true)
    expect(
      shouldSuppressRendererUnresponsive({
        isDev: false,
        isDevToolsOpened: false,
        debuggerAttached: false
      })
    ).toBe(false)
  })
})
