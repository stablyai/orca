import { describe, expect, it } from 'vitest'
import { GLYPH_CURSOR_PREFIX } from '../hud/hud-glyphs'
import type { DashboardRow, HudState } from '../state/hud-store'
import { dashboardPageCount, renderDashboardScreen, statusGlyph } from './dashboard-screen'

const HOST = {
  id: 'h1',
  name: 'desktop-1',
  endpoint: 'ws://a',
  deviceToken: 't',
  publicKeyB64: 'k',
  lastConnected: 0
}

function fixtureState(
  rows: DashboardRow[],
  cursorOrPage = 0,
  overrides: Partial<HudState> = {}
): HudState {
  return {
    connection: { hostId: 'h1', state: 'connected', compat: null },
    hosts: [HOST],
    dashboard: { rows, fetchedAt: 1000, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askInteraction: null,
    nav: {
      stack: [{ screen: 'dashboard', hostId: 'h1', cursor: cursorOrPage, page: cursorOrPage }],
      exitDialogArmed: false
    },
    ...overrides
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

describe('renderDashboardScreen — HIGH #3 connection/freshness branching', () => {
  it('shows a connecting message (not "no worktrees") while connecting/handshaking', () => {
    for (const state of ['connecting', 'handshaking'] as const) {
      const page = renderDashboardScreen(
        fixtureState([], 0, { connection: { hostId: 'h1', state, compat: null } })
      )
      expect(page.header).toBe('Connecting to desktop-1…')
      expect(page.body).toBe('Connecting…')
    }
  })

  it('shows a reconnecting message while reconnecting', () => {
    const page = renderDashboardScreen(
      fixtureState([], 0, { connection: { hostId: 'h1', state: 'reconnecting', compat: null } })
    )
    expect(page.header).toBe('Reconnecting to desktop-1…')
    expect(page.body).toBe('Reconnecting…')
  })

  it('shows a not-connected message (with lastError if present) when disconnected/auth-failed', () => {
    const page = renderDashboardScreen(
      fixtureState([], 0, {
        connection: { hostId: 'h1', state: 'disconnected', compat: null, lastError: 'timed out' }
      })
    )
    expect(page.header).toBe('Not connected — desktop-1')
    expect(page.body).toBe('timed out')
  })

  it('ignores connection.state when it names a different host than this frame', () => {
    // v1 tracks one host's connection at a time; a `connection` slice for an unrelated (or no)
    // host says nothing about frame.hostId's connection, so it must not paint a connecting/
    // disconnected message over what could otherwise be perfectly good rows-based rendering.
    const page = renderDashboardScreen(
      fixtureState([], 0, { connection: { hostId: null, state: 'disconnected', compat: null } })
    )
    expect(page.header).not.toContain('Not connected')
  })

  it('shows Loading… when connected but no poll has landed yet (fetchedAt === 0)', () => {
    const page = renderDashboardScreen(
      fixtureState([], 0, { dashboard: { rows: [], fetchedAt: 0, stale: false } })
    )
    expect(page.header).toBe('Orca · Loading…')
    expect(page.body).toBe('Loading…')
  })

  it('shows a genuine "No worktrees" once connected and fetched with zero rows', () => {
    const page = renderDashboardScreen(fixtureState([]))
    expect(page.body).toBe('No worktrees')
    expect(page.header).toBe('Orca · 0 running · 1/1')
  })

  it('flags a stale poll as connection-lost while still showing the last-known rows', () => {
    const rows: DashboardRow[] = [
      { worktreeId: 'wt-1', displayName: 'api', status: 'working', elapsedLabel: '12m' }
    ]
    const page = renderDashboardScreen(
      fixtureState(rows, 0, { dashboard: { rows, fetchedAt: 5 * 60_000, stale: true } }),
      12 * 60_000
    )
    expect(page.header).toBe('Connection lost — last update 7m ago')
    expect(page.body).toContain('api')
  })
})

describe('renderDashboardScreen — rows', () => {
  it('renders a cursor row with the new one-line format (glyph, name, status word, elapsed)', () => {
    const rows: DashboardRow[] = [
      { worktreeId: 'wt-1', displayName: 'api', status: 'working', elapsedLabel: '12m' },
      { worktreeId: 'wt-2', displayName: 'web', status: 'permission', elapsedLabel: '3m' }
    ]
    const page = renderDashboardScreen(fixtureState(rows, 1))
    expect(page.body).toBe(`  ▶ api — running  12m\n${GLYPH_CURSOR_PREFIX} ▲ web — waiting  3m`)
  })

  it('MEDIUM #6: leads the header with a needs-input count when any row is waiting', () => {
    const rows: DashboardRow[] = [
      { worktreeId: 'wt-1', displayName: 'api', status: 'working' },
      { worktreeId: 'wt-2', displayName: 'web', status: 'permission' }
    ]
    const page = renderDashboardScreen(fixtureState(rows))
    expect(page.header).toBe('▲ 1 need you · 1/1')
  })

  it('falls back to a running-count header when nothing needs input', () => {
    const rows: DashboardRow[] = [
      { worktreeId: 'wt-1', displayName: 'api', status: 'working' },
      { worktreeId: 'wt-2', displayName: 'web', status: 'done' }
    ]
    const page = renderDashboardScreen(fixtureState(rows))
    expect(page.header).toBe('Orca · 1 running · 1/1')
  })

  it('paginates in fixed-size chunks once content overflows one page', () => {
    const rows: DashboardRow[] = Array.from({ length: 12 }, (_, i) => ({
      worktreeId: `wt-${i}`,
      displayName: `worktree-${i}`,
      status: 'working' as const,
      elapsedLabel: '1m'
    }))
    const count = dashboardPageCount(rows)
    expect(count).toBe(2)

    const page = renderDashboardScreen(fixtureState(rows, 0))
    expect(page.header).toBe(`Orca · 12 running · 1/${count}`)
  })

  it('HIGH #5: two names sharing a 19-char prefix stay distinguishable in rendered rows', () => {
    const prefix = 'x'.repeat(19)
    const rows: DashboardRow[] = [
      { worktreeId: 'wt-a', displayName: `${prefix}AAAAAA`, status: 'working' },
      { worktreeId: 'wt-b', displayName: `${prefix}BBBBBB`, status: 'working' }
    ]
    const page = renderDashboardScreen(fixtureState(rows))
    expect(page.body).toContain('AAAAAA')
    expect(page.body).toContain('BBBBBB')
    const lines = page.body.split('\n')
    expect(lines[0]).not.toBe(lines[1])
  })
})

describe('renderDashboardScreen — footer derives back/exit from stack depth (MEDIUM #7)', () => {
  it('shows 2tap=exit at the root of the stack', () => {
    const page = renderDashboardScreen(fixtureState([]))
    expect(page.footer).toBe('scroll=select  click=open  2tap=exit')
  })

  it('shows 2tap=back when the dashboard is not the root frame', () => {
    const state = fixtureState([])
    state.nav.stack = [
      { screen: 'hostList', selectedIndex: 0 },
      { screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 }
    ]
    const page = renderDashboardScreen(state)
    expect(page.footer).toBe('scroll=select  click=open  2tap=back')
  })
})
