// @vitest-environment happy-dom
import { useEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { showWorkspaceListThen } from '@/components/app-rail/app-rail-navigation'
import { AppShellLeftColumn } from './AppShellLeftColumn'
import { useAppChromeLayout } from './use-app-chrome-layout'

// Invariant: with the rail on, the workspace list (which owns unsaved dialog drafts, dialog focus and the Workspace
// Board) keeps its instance when views change, and across rail flag flips while the column header is mounted.
// Accepted, not asserted: a flag flip with no header mounted (a rail page, or Landing with the list hidden) remounts
// the list once, because the rail-off layout must stay exactly the plain one (see the component's comment).

let mounts = 0

function ListProbe(): React.JSX.Element {
  useEffect(() => {
    mounts += 1
  }, [])
  return <div data-list-probe="" />
}

function Host(): React.JSX.Element {
  const layout = useAppChromeLayout()
  return (
    <AppShellLeftColumn
      layout={layout}
      titlebarLeftControls={<div />}
      rail={<div />}
      list={<ListProbe />}
    />
  )
}

const initial = useAppStore.getState()

function setRail(on: boolean): void {
  useAppStore.setState({
    settings: {
      ...(initial.settings ?? getDefaultSettings('/fixture-home')),
      experimentalAppRail: on
    }
  })
}

function start(state: Partial<AppState>, railOn = true): HTMLElement {
  useAppStore.setState(state)
  setRail(railOn)
  const { container } = render(<Host />)
  return container
}

function probeInColumn(container: HTMLElement): boolean {
  return container.querySelector('[data-left-column-list] [data-list-probe]') !== null
}

beforeEach(() => {
  mounts = 0
  useAppStore.setState(initial, true)
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

const ACTIVE_WORKSPACE: Partial<AppState> = { activeView: 'terminal', activeWorktreeId: 'wt-1' }

it('keeps the list instance from an active workspace to a rail page with the list saved closed', () => {
  // Main moves the list from the column to a sibling here (the header unmounts), remounting it.
  for (const open of [
    (s: AppState) => s.openAutomationsPage(),
    (s: AppState) => s.openTaskPage()
  ]) {
    mounts = 0
    const container = start({ ...ACTIVE_WORKSPACE, sidebarOpen: false })
    act(() => open(useAppStore.getState()))
    expect(mounts).toBe(1)
    expect(probeInColumn(container)).toBe(true)
    cleanup()
    useAppStore.setState(initial, true)
  }
})

it('keeps the list instance when a list command leaves a rail page with the list saved closed', () => {
  // The Board-command case: main moves the list from a sibling into the column as the list opens.
  const container = start({ activeView: 'terminal', sidebarOpen: false })
  act(() => useAppStore.getState().openTaskPage())
  act(() => {
    showWorkspaceListThen(useAppStore)
  })
  expect(useAppStore.getState()).toMatchObject({ activeView: 'terminal', sidebarOpen: true })
  expect(mounts).toBe(1)
  expect(probeInColumn(container)).toBe(true)
})

it('keeps the list instance from an active workspace to a rail page with the list saved open', () => {
  const container = start({ ...ACTIVE_WORKSPACE, sidebarOpen: true })
  act(() => useAppStore.getState().openAutomationsPage())
  expect(mounts).toBe(1)
  expect(probeInColumn(container)).toBe(true)
})

it('keeps the list instance across rail flag flips while the header is mounted', () => {
  for (const state of [
    { ...ACTIVE_WORKSPACE, sidebarOpen: false },
    { ...ACTIVE_WORKSPACE, sidebarOpen: true },
    // The startup state: no workspace yet, the list at its default (open).
    { activeView: 'terminal' as const, activeWorktreeId: null, sidebarOpen: true }
  ]) {
    mounts = 0
    start(state, true)
    act(() => setRail(false))
    act(() => setRail(true))
    expect(mounts).toBe(1)
    cleanup()
    useAppStore.setState(initial, true)
  }
})
