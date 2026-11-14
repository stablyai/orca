import { describe, expect, it } from 'vitest'
import type { DashboardRow, HudState } from '../state/hud-store'
import { renderWorktreeListScreen, worktreeListPageCount } from './worktree-list-screen'

function fixtureState(rows: DashboardRow[], page = 0): HudState {
  return {
    connection: { hostId: 'h1', state: 'connected', compat: null },
    hosts: [],
    dashboard: { rows, fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askInteraction: null,
    nav: {
      stack: [{ screen: 'worktreeList', hostId: 'h1', selectedIndex: 0, page }],
      exitDialogArmed: false
    }
  }
}

describe('worktreeListPageCount', () => {
  it('is 1 page under the 20-item cap, more above it', () => {
    expect(worktreeListPageCount(0)).toBe(1)
    expect(worktreeListPageCount(20)).toBe(1)
    expect(worktreeListPageCount(21)).toBe(2)
  })
})

describe('renderWorktreeListScreen', () => {
  it('shows a placeholder when there are no worktrees', () => {
    const page = renderWorktreeListScreen(fixtureState([]))
    expect(page).toEqual({
      layout: 'list',
      header: 'Worktrees · 0 · page 1/1',
      items: ['No worktrees'],
      footer: 'click=open  2tap=back'
    })
  })

  it('prefixes each row with its status glyph', () => {
    const rows: DashboardRow[] = [
      { worktreeId: 'wt-1', displayName: 'api-refactor', status: 'working' },
      { worktreeId: 'wt-2', displayName: 'docs', status: 'done' }
    ]
    const page = renderWorktreeListScreen(fixtureState(rows))
    expect(page.layout).toBe('list')
    if (page.layout !== 'list') {
      throw new Error('expected list layout')
    }
    expect(page.items).toEqual(['▶ api-refactor', '● docs'])
    expect(page.header).toBe('Worktrees · 2 · page 1/1')
  })

  it('MEDIUM #9: a status change alone does not reorder rows — position tracks array order', () => {
    const before: DashboardRow[] = [
      { worktreeId: 'wt-a', displayName: 'alpha', status: 'working' },
      { worktreeId: 'wt-b', displayName: 'beta', status: 'permission' },
      { worktreeId: 'wt-c', displayName: 'gamma', status: 'done' }
    ]
    const after: DashboardRow[] = [
      { worktreeId: 'wt-a', displayName: 'alpha', status: 'done' }, // status changed
      { worktreeId: 'wt-b', displayName: 'beta', status: 'permission' },
      { worktreeId: 'wt-c', displayName: 'gamma', status: 'done' }
    ]
    const namesOf = (page: ReturnType<typeof renderWorktreeListScreen>) =>
      page.layout === 'list' ? page.items.map((item) => item.split(' ')[1]) : []

    expect(namesOf(renderWorktreeListScreen(fixtureState(before)))).toEqual([
      'alpha',
      'beta',
      'gamma'
    ])
    expect(namesOf(renderWorktreeListScreen(fixtureState(after)))).toEqual([
      'alpha',
      'beta',
      'gamma'
    ])
  })

  it('paginates beyond the 20-item hard cap', () => {
    const rows: DashboardRow[] = Array.from({ length: 25 }, (_, i) => ({
      worktreeId: `wt-${i}`,
      displayName: `wt-${i}`,
      status: 'inactive' as const
    }))
    const page = renderWorktreeListScreen(fixtureState(rows, 1))
    expect(page.layout).toBe('list')
    if (page.layout !== 'list') {
      throw new Error('expected list layout')
    }
    expect(page.header).toBe('Worktrees · 25 · page 2/2')
    expect(page.items).toHaveLength(5)
  })
})
