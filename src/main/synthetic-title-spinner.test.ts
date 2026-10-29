import { describe, expect, it } from 'vitest'
import {
  advanceSyntheticTitleSpinnerEntries,
  getSyntheticTitleSpinnerPaneKeyToStop,
  type SyntheticTitleSpinnerEntry
} from './synthetic-title-spinner'

describe('advanceSyntheticTitleSpinnerEntries', () => {
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

describe('getSyntheticTitleSpinnerPaneKeyToStop', () => {
  it('keeps pane spinners running for a connection-scoped transient clear', () => {
    expect(
      getSyntheticTitleSpinnerPaneKeyToStop({
        transient: true,
        connectionId: 'ssh-a',
        clearedAt: 42
      })
    ).toBeNull()
  })
})
