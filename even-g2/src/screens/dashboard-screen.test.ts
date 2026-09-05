import { describe, expect, it } from 'vitest'
import { GLYPH_CURSOR_PREFIX, toFullwidthColumns } from '../hud/hud-glyphs'
import type { DashboardRow, HudState } from '../state/hud-store'
import { dashboardPageCount, renderDashboardScreen, statusGlyph } from './dashboard-screen'

function fixtureState(rows: DashboardRow[], page = 0): HudState {
  return {
    connection: { hostId: 'h1', state: 'connected', compat: null },
    hosts: [],
    dashboard: { rows, fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askAnswered: null,
    nav: { stack: [{ screen: 'dashboard', hostId: 'h1', page }], exitDialogArmed: false }
  }
}

describe('statusGlyph', () => {
  it('maps every worktree status to its verified glyph', () => {
    expect(statusGlyph('working')).toBe('▶')
    expect(statusGlyph('active')).toBe('▶')
    expect(statusGlyph('permission')).toBe('▲')
    expect(statusGlyph('done')).toBe('●')
    expect(statusGlyph('inactive')).toBe('○')
    expect(statusGlyph(undefined)).toBe('◇')
  })
})

describe('renderDashboardScreen', () => {
  it('shows the empty state with correct counts', () => {
    const page = renderDashboardScreen(fixtureState([]))
    expect(page).toEqual({
      layout: 'text',
      header: 'Orca · 0 running · 0 waiting · page 1/1',
      body: 'No worktrees yet',
      footer: 'scroll=select  click=open  2tap=back'
    })
  })

  it('renders a cursor row when the dashboard fits on one page', () => {
    const rows: DashboardRow[] = [
      { worktreeId: 'wt-1', displayName: 'api', status: 'working', elapsedLabel: '12m' },
      { worktreeId: 'wt-2', displayName: 'web', status: 'permission', elapsedLabel: '3m' }
    ]
    const page = renderDashboardScreen(fixtureState(rows, 1))
    const lines = toFullwidthColumns(
      [
        ['▶', 'api', '12m'],
        ['▲', 'web', '3m']
      ],
      [2, 20, 6]
    )
    expect(page.layout).toBe('text')
    if (page.layout !== 'text') {
      throw new Error('expected text layout')
    }
    expect(page.header).toBe('Orca · 1 running · 1 waiting · page 1/1')
    expect(page.body).toBe(`  ${lines[0]}\n${GLYPH_CURSOR_PREFIX} ${lines[1]}`)
    expect(page.footer).toBe('scroll=select  click=open  2tap=back')
  })

  it('paginates and reports page x/y once dashboard content overflows one page', () => {
    const rows: DashboardRow[] = Array.from({ length: 12 }, (_, i) => ({
      worktreeId: `wt-${i}`,
      displayName: `worktree-${i}`,
      status: 'working' as const,
      elapsedLabel: '1m'
    }))
    const count = dashboardPageCount(rows)
    expect(count).toBeGreaterThan(1)

    const page = renderDashboardScreen(fixtureState(rows, 0))
    expect(page.layout).toBe('text')
    if (page.layout !== 'text') {
      throw new Error('expected text layout')
    }
    expect(page.header).toBe(`Orca · 12 running · 0 waiting · page 1/${count}`)
    expect(page.footer).toBe('scroll=pages  click=list  2tap=back')
  })
})
