import { describe, it, expect } from 'vitest'
import {
  nextActivePanel,
  resolvePanelAction,
  panelRouteDescriptor,
  type ActivePanel
} from './session-panel-host'

const PANELS = ['sourceControl', 'files', 'pr'] as const

describe('nextActivePanel', () => {
  it('opens a panel from the closed state', () => {
    for (const panel of PANELS) {
      expect(nextActivePanel(null, panel)).toBe(panel)
    }
  })

  it('closes the panel when tapping the active one', () => {
    for (const panel of PANELS) {
      expect(nextActivePanel(panel, panel)).toBeNull()
    }
  })

  it('swaps to a different panel', () => {
    expect(nextActivePanel('sourceControl', 'files')).toBe('files')
    expect(nextActivePanel('files', 'pr')).toBe('pr')
    expect(nextActivePanel('pr', 'sourceControl')).toBe('sourceControl')
  })
})

describe('resolvePanelAction', () => {
  it('docks with the opened panel on wide layouts (open)', () => {
    expect(resolvePanelAction({ isWideLayout: true, tapped: 'files', current: null })).toEqual({
      kind: 'dock',
      next: 'files'
    })
  })

  it('docks with null on wide layouts when tapping the active panel (close)', () => {
    expect(resolvePanelAction({ isWideLayout: true, tapped: 'pr', current: 'pr' })).toEqual({
      kind: 'dock',
      next: null
    })
  })

  it('docks with the new panel on wide layouts (swap)', () => {
    expect(
      resolvePanelAction({ isWideLayout: true, tapped: 'sourceControl', current: 'files' })
    ).toEqual({ kind: 'dock', next: 'sourceControl' })
  })

  it('pushes the tapped panel on narrow layouts regardless of current', () => {
    const currents: ActivePanel[] = [null, 'sourceControl', 'files', 'pr']
    for (const panel of PANELS) {
      for (const current of currents) {
        expect(resolvePanelAction({ isWideLayout: false, tapped: panel, current })).toEqual({
          kind: 'push',
          panel
        })
      }
    }
  })
})

describe('panelRouteDescriptor', () => {
  it('maps each panel to its expo-router pathname', () => {
    expect(panelRouteDescriptor('sourceControl')).toEqual({
      pathname: '/h/[hostId]/source-control/[worktreeId]'
    })
    expect(panelRouteDescriptor('files')).toEqual({
      pathname: '/h/[hostId]/files/[worktreeId]'
    })
    expect(panelRouteDescriptor('pr')).toEqual({
      pathname: '/h/[hostId]/pr/[worktreeId]'
    })
  })
})
