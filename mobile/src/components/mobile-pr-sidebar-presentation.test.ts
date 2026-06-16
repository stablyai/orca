import { describe, expect, it } from 'vitest'
import {
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
})

describe('shouldShowTrigger', () => {
  it('shows the trigger on a GitHub repo in narrow/overlay mode', () => {
    expect(shouldShowTrigger({ isGithubRepo: true, isWideLayout: false })).toBe(true)
  })

  it('hides the trigger in wide/docked mode even on a GitHub repo', () => {
    expect(shouldShowTrigger({ isGithubRepo: true, isWideLayout: true })).toBe(false)
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
