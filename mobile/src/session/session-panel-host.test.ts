import { describe, it, expect } from 'vitest'
import {
  canDockSessionPanel,
  nextActivePanel,
  resolvePanelAction,
  panelRouteDescriptor,
  shouldShowSessionHeaderChecksAction,
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
    expect(resolvePanelAction({ canDock: true, tapped: 'files', current: null })).toEqual({
      kind: 'dock',
      next: 'files'
    })
  })

  it('docks with null on wide layouts when tapping the active panel (close)', () => {
    expect(resolvePanelAction({ canDock: true, tapped: 'pr', current: 'pr' })).toEqual({
      kind: 'dock',
      next: null
    })
  })

  it('docks with the new panel on wide layouts (swap)', () => {
    expect(
      resolvePanelAction({ canDock: true, tapped: 'sourceControl', current: 'files' })
    ).toEqual({ kind: 'dock', next: 'sourceControl' })
  })

  it('pushes the tapped panel when docking is unavailable regardless of current', () => {
    const currents: ActivePanel[] = [null, 'sourceControl', 'files', 'pr']
    for (const panel of PANELS) {
      for (const current of currents) {
        expect(resolvePanelAction({ canDock: false, tapped: panel, current })).toEqual({
          kind: 'push',
          panel
        })
      }
    }
  })
})

describe('canDockSessionPanel', () => {
  it('requires a wide layout and enough measured content-row width', () => {
    expect(canDockSessionPanel({ isWideLayout: true, availableWidth: 700, dockWidth: 340 })).toBe(
      true
    )
    expect(canDockSessionPanel({ isWideLayout: true, availableWidth: 699, dockWidth: 340 })).toBe(
      false
    )
    expect(canDockSessionPanel({ isWideLayout: false, availableWidth: 900, dockWidth: 340 })).toBe(
      false
    )
  })
})

describe('shouldShowSessionHeaderChecksAction', () => {
  it('shows Checks on git worktree routes once a checks-capable provider is confirmed', () => {
    expect(
      shouldShowSessionHeaderChecksAction({
        isFolderWorkspaceRoute: false,
        repoContextLoaded: true,
        hostedChecksSupported: true
      })
    ).toBe(true)
  })

  it('hides Checks for providers without hosted checks (pr-panel guard would no-op it)', () => {
    expect(
      shouldShowSessionHeaderChecksAction({
        isFolderWorkspaceRoute: false,
        repoContextLoaded: true,
        hostedChecksSupported: false
      })
    ).toBe(false)
  })

  it('hides Checks until the provider probe resolves', () => {
    expect(
      shouldShowSessionHeaderChecksAction({
        isFolderWorkspaceRoute: false,
        repoContextLoaded: false,
        hostedChecksSupported: false
      })
    ).toBe(false)
  })

  it('hides Checks on folder workspace session routes', () => {
    expect(
      shouldShowSessionHeaderChecksAction({
        isFolderWorkspaceRoute: true,
        repoContextLoaded: true,
        hostedChecksSupported: true
      })
    ).toBe(false)
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
      pathname: '/h/[hostId]/source-control/[worktreeId]',
      params: { tab: 'pr' }
    })
  })
})
