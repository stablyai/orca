// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PersistenceStatusBanner } from './PersistenceStatusBanner'

let persistenceStatus: Record<string, { status: string; lastError?: string }> = {}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ persistenceStatus })
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector
}))

afterEach(() => {
  cleanup()
  persistenceStatus = {}
})

describe('PersistenceStatusBanner', () => {
  it('renders nothing when no kind has status "error"', () => {
    persistenceStatus = {
      keybindings: { status: 'synced' },
      uiLocal: { status: 'pending' }
    }
    const { container } = render(<PersistenceStatusBanner />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when persistenceStatus is empty', () => {
    persistenceStatus = {}
    const { container } = render(<PersistenceStatusBanner />)

    expect(container).toBeEmptyDOMElement()
  })

  it('shows an alert banner when a kind has status "error"', () => {
    persistenceStatus = { keybindings: { status: 'error', lastError: 'offline' } }
    render(<PersistenceStatusBanner />)

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('keyboard shortcuts')
  })

  it('lists every kind currently in an error state', () => {
    persistenceStatus = {
      keybindings: { status: 'error' },
      uiLocal: { status: 'error' },
      savedRuntimeEnvironments: { status: 'synced' }
    }
    render(<PersistenceStatusBanner />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('keyboard shortcuts')
    expect(alert).toHaveTextContent('UI preferences')
    expect(alert).not.toHaveTextContent('saved servers')
  })
})
