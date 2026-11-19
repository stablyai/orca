// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { AppShellLeftColumn } from './AppShellLeftColumn'

let listMounts = 0

// Stands in for the workspace list: local state plus a mount counter.
function StubList(): React.JSX.Element {
  const [query, setQuery] = useState('')
  useEffect(() => {
    listMounts += 1
  }, [])
  return (
    <input
      aria-label="Filter workspaces"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
    />
  )
}

let railMounts = 0

// Stands in for the rail button: a mount counter.
function StubRail(): React.JSX.Element {
  useEffect(() => {
    railMounts += 1
  }, [])
  return <button type="button">Workspaces</button>
}

// shouldMount=false is a page such as Tasks with the list collapsed: the list is hidden but still hosts its dialogs.
function layout(appRailVisible: boolean, sidebarOpen = true, shouldMount = true) {
  return {
    appRailVisible,
    showSidebar: true,
    sidebarOpen,
    leftTitlebarChromeLayout: { shouldMount, isFloating: shouldMount && !sidebarOpen },
    leftSidebarStyle: {}
  }
}

function column(
  appRailVisible: boolean,
  sidebarOpen = true,
  shouldMount = true
): React.JSX.Element {
  return (
    <AppShellLeftColumn
      layout={layout(appRailVisible, sidebarOpen, shouldMount)}
      titlebarLeftControls={<button type="button">Toggle sidebar</button>}
      rail={<StubRail />}
      list={<StubList />}
    />
  )
}

afterEach(() => {
  cleanup()
  listMounts = 0
  railMounts = 0
})

it('keeps the focused list, its node and its local state when the rail flag flips either way', () => {
  const { rerender } = render(column(false))
  const input = screen.getByLabelText('Filter workspaces')
  fireEvent.change(input, { target: { value: 'acme' } })
  input.focus()

  // A late Settings publish turns the rail on, then off again, while the user is in the list.
  rerender(column(true))
  rerender(column(false))

  expect(screen.getByLabelText('Filter workspaces')).toBe(input)
  expect(input).toHaveValue('acme')
  expect(input).toHaveFocus()
  expect(listMounts).toBe(1)
})

it('keeps the list when the flag flips with the list collapsed', () => {
  const { rerender } = render(column(true, false))
  const input = screen.getByLabelText('Filter workspaces')
  rerender(column(false, false))
  rerender(column(true, false))
  expect(screen.getByLabelText('Filter workspaces')).toBe(input)
  expect(listMounts).toBe(1)
})

it('puts the titlebar, then the rail, then the list in DOM order with the rail on', () => {
  render(column(true))
  const toggle = screen.getByRole('button', { name: 'Toggle sidebar' })
  const rail = screen.getByRole('button', { name: 'Workspaces' })
  const list = screen.getByLabelText('Filter workspaces')
  expect(toggle.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(rail.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('renders the plain sidebar column with the rail off', () => {
  const { container } = render(column(false))
  const root = container.firstElementChild
  expect(root?.className).toBe('flex min-h-0 flex-col shrink-0')
  expect(root?.children).toHaveLength(2)
  const [header, viewport] = Array.from(root?.children ?? [])
  if (!(header instanceof HTMLElement)) {
    throw new Error('expected the titlebar header element')
  }
  expect(header.className).toBe('titlebar-left')
  expect(header.style.width).toBe('100%')
  expect(viewport?.className).toBe('flex min-h-0 flex-1')
  expect(screen.queryByRole('button', { name: 'Workspaces' })).toBeNull()
})

it('keeps an unsaved draft in the hidden list on a collapsed page when the rail flag flips either way', () => {
  // Rail on, Tasks with the list collapsed: a Workspace details draft lives in the list's subtree.
  const { rerender } = render(column(true, false, false))
  const input = screen.getByLabelText('Filter workspaces')
  fireEvent.change(input, { target: { value: 'unsaved draft' } })

  rerender(column(false, false, false))
  rerender(column(true, false, false))

  expect(screen.getByLabelText('Filter workspaces')).toBe(input)
  expect(input).toHaveValue('unsaved draft')
  expect(listMounts).toBe(1)
})

it('keeps the rail mounted when a page switch moves the list in or out of the column', () => {
  const { rerender } = render(column(true, true, true))
  rerender(column(true, false, false))
  rerender(column(true, true, true))
  expect(railMounts).toBe(1)
})

it('renders the plain hidden list with the rail off on a collapsed page', () => {
  const { container } = render(column(false, false, false))
  expect(container.children).toHaveLength(1)
  expect(container.firstElementChild).toBe(screen.getByLabelText('Filter workspaces'))
})
