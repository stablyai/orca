import { describe, expect, it } from 'vitest'
import {
  selectHostWorkspaceListState,
  type HostWorkspaceListStateInput
} from './host-workspace-list-state'

function input(overrides: Partial<HostWorkspaceListStateInput>): HostWorkspaceListStateInput {
  return {
    connState: 'connected',
    worktreesLoaded: true,
    displayCount: 0,
    sectionCount: 0,
    catalogError: null,
    ...overrides
  }
}

// Regression guard for STA-3123: a remote host whose worktree.ps fails must render
// as a catalog failure, never as a healthy host with zero workspaces.
describe('selectHostWorkspaceListState', () => {
  it('reports catalog-error instead of empty when the fetch failed with no rows', () => {
    expect(selectHostWorkspaceListState(input({ catalogError: 'forbidden' }))).toBe('catalog-error')
    expect(
      selectHostWorkspaceListState(input({ catalogError: 'forbidden', worktreesLoaded: false }))
    ).toBe('catalog-error')
  })

  it('keeps showing cached rows (no overlay) when a later fetch fails', () => {
    expect(
      selectHostWorkspaceListState(
        input({ catalogError: 'network_error', displayCount: 3, sectionCount: 2 })
      )
    ).toBeNull()
  })

  it('still reports empty for a filtered-out cached list during a failure', () => {
    expect(
      selectHostWorkspaceListState(
        input({ catalogError: 'network_error', displayCount: 3, sectionCount: 0 })
      )
    ).toBe('empty')
  })

  it('reports empty only after a successful load confirmed zero workspaces', () => {
    expect(selectHostWorkspaceListState(input({}))).toBe('empty')
    expect(selectHostWorkspaceListState(input({ worktreesLoaded: false }))).toBe('loading')
  })

  it('shows the spinner while connecting regardless of error state', () => {
    expect(
      selectHostWorkspaceListState(input({ connState: 'reconnecting', catalogError: 'x' }))
    ).toBe('loading')
    expect(
      selectHostWorkspaceListState(
        input({ connState: 'connecting', worktreesLoaded: false, catalogError: null })
      )
    ).toBe('loading')
  })

  it('renders nothing while disconnected with cached rows', () => {
    expect(
      selectHostWorkspaceListState(
        input({ connState: 'disconnected', displayCount: 2, sectionCount: 1 })
      )
    ).toBeNull()
  })
})
