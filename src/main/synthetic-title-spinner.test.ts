import { describe, expect, it } from 'vitest'
import {
  advanceSyntheticTitleSpinnerEntries,
  type SyntheticTitleSpinnerEntry
} from './synthetic-title-spinner'

describe('advanceSyntheticTitleSpinnerEntries', () => {
  it('advances live panes in one shared tick and wraps frames', () => {
    const entries = new Map<string, SyntheticTitleSpinnerEntry<{ label: string }>>([
      ['pane-a', { frame: 1, profile: { label: 'A' } }],
      ['pane-b', { frame: 2, profile: { label: 'B' } }]
    ])

    const ticks = advanceSyntheticTitleSpinnerEntries({
      entries,
      frameCount: 3,
      getPtyIdForPaneKey: (paneKey) => `pty-${paneKey}`
    })

    expect(ticks).toEqual([
      { paneKey: 'pane-a', ptyId: 'pty-pane-a', frame: 2, profile: { label: 'A' } },
      { paneKey: 'pane-b', ptyId: 'pty-pane-b', frame: 0, profile: { label: 'B' } }
    ])
    expect(entries.get('pane-a')?.frame).toBe(2)
    expect(entries.get('pane-b')?.frame).toBe(0)
  })

  it('drops panes whose pty mapping disappeared', () => {
    const entries = new Map<string, SyntheticTitleSpinnerEntry<{ label: string }>>([
      ['live-pane', { frame: 0, profile: { label: 'live' } }],
      ['stale-pane', { frame: 0, profile: { label: 'stale' } }]
    ])

    const ticks = advanceSyntheticTitleSpinnerEntries({
      entries,
      frameCount: 4,
      getPtyIdForPaneKey: (paneKey) => (paneKey === 'stale-pane' ? null : `pty-${paneKey}`)
    })

    expect(ticks).toEqual([
      { paneKey: 'live-pane', ptyId: 'pty-live-pane', frame: 1, profile: { label: 'live' } }
    ])
    expect(entries.has('live-pane')).toBe(true)
    expect(entries.has('stale-pane')).toBe(false)
  })
})
