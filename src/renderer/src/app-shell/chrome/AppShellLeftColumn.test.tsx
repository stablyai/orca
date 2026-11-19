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

function layout(appRailVisible: boolean, sidebarOpen = true) {
  return {
    appRailVisible,
    showSidebar: true,
    sidebarOpen,
    leftTitlebarChromeLayout: { shouldMount: true, isFloating: !sidebarOpen },
    leftSidebarStyle: {}
  }
}

function column(appRailVisible: boolean, sidebarOpen = true): React.JSX.Element {
  return (
    <AppShellLeftColumn
      layout={layout(appRailVisible, sidebarOpen)}
      titlebarLeftControls={<button type="button">Toggle sidebar</button>}
      rail={<button type="button">Workspaces</button>}
      list={<StubList />}
    />
  )
}

afterEach(() => {
  cleanup()
  listMounts = 0
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
