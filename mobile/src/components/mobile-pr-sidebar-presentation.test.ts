import { describe, expect, it } from 'vitest'
import {
  canDockPrSidebar,
  prSidebarRenderBranch,
  resolvePresentationMode,
  shouldShowTrigger
} from './mobile-pr-sidebar-presentation'
import type { PrSidebarData, PrSidebarState } from '../session/mobile-pr-sidebar-state'

describe('resolvePresentationMode', () => {
  it('docks inline on wide layouts and overlays on narrow', () => {
    expect(resolvePresentationMode(true)).toBe('inline')
    expect(resolvePresentationMode(false)).toBe('overlay')
  })

  it('overlays on wide layouts when the measured pane cannot fit both columns', () => {
    expect(resolvePresentationMode(true, false)).toBe('overlay')
  })
})

describe('canDockPrSidebar', () => {
  it('requires both wide layout and enough measured width', () => {
    expect(canDockPrSidebar({ isWideLayout: true, availableWidth: 700, dockWidth: 340 })).toBe(true)
    expect(canDockPrSidebar({ isWideLayout: true, availableWidth: 699, dockWidth: 340 })).toBe(
      false
    )
    expect(canDockPrSidebar({ isWideLayout: false, availableWidth: 900, dockWidth: 340 })).toBe(
      false
    )
  })
})

describe('shouldShowTrigger', () => {
  it('shows the trigger on a GitHub repo in narrow/overlay mode', () => {
    expect(shouldShowTrigger({ isGithubRepo: true, isWideLayout: false })).toBe(true)
  })

  it('hides the trigger in wide/docked mode even on a GitHub repo', () => {
    expect(shouldShowTrigger({ isGithubRepo: true, isWideLayout: true })).toBe(false)
  })

  it('shows the trigger on a wide GitHub repo when the sidebar cannot dock', () => {
    expect(shouldShowTrigger({ isGithubRepo: true, isWideLayout: true, canDock: false })).toBe(true)
  })

  it('hides the trigger on a non-GitHub repo regardless of layout', () => {
    expect(shouldShowTrigger({ isGithubRepo: false, isWideLayout: false })).toBe(false)
    expect(shouldShowTrigger({ isGithubRepo: false, isWideLayout: true })).toBe(false)
  })
})

describe('prSidebarRenderBranch', () => {
  const cases: PrSidebarState[] = [
    { kind: 'hidden' },
    { kind: 'loading' },
    { kind: 'none' },
    { kind: 'error', message: 'boom' },
    { kind: 'blocked', message: 'no auth' },
    { kind: 'ready', data: {} as PrSidebarData }
  ]

  it('maps each state kind to its render branch', () => {
    for (const state of cases) {
      expect(prSidebarRenderBranch(state)).toBe(state.kind)
    }
  })
})
