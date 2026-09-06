import { describe, expect, it } from 'vitest'
import { paginateHudBody } from '../hud/hud-text-pagination'
import type { DashboardRow, HudState } from '../state/hud-store'
import { renderTerminalTailScreen, terminalTailPageCount } from './terminal-tail-screen'

function fixtureState(opts: {
  terminalId: string | null
  lines: string[]
  frameTerminalId: string
  page?: number
  worktreeId?: string
  dashboardRows?: DashboardRow[]
  loading?: boolean
  unavailable?: boolean
}): HudState {
  return {
    connection: { hostId: 'h1', state: 'connected', compat: null },
    hosts: [],
    dashboard: { rows: opts.dashboardRows ?? [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: {
      terminalId: opts.terminalId,
      lines: opts.lines,
      live: true,
      loading: opts.loading,
      unavailable: opts.unavailable
    },
    device: null,
    askInteraction: null,
    nav: {
      stack: [
        {
          screen: 'terminalTail',
          hostId: 'h1',
          worktreeId: opts.worktreeId ?? 'wt-1',
          terminalId: opts.frameTerminalId,
          page: opts.page ?? 0
        }
      ],
      exitDialogArmed: false
    }
  }
}

describe('terminalTailPageCount', () => {
  it('is at least 1 even for empty lines', () => {
    expect(terminalTailPageCount([])).toBe(1)
  })

  it('matches paginateHudBody output length', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    expect(terminalTailPageCount(lines)).toBe(paginateHudBody(lines).length)
  })
})

describe('renderTerminalTailScreen', () => {
  // Finding #4: every non-content state renders an explicit message — never a blank body.
  it('shows "No active terminal" while the frame terminalId is still the "" placeholder', () => {
    const state = fixtureState({ terminalId: null, lines: [], frameTerminalId: '' })
    const page = renderTerminalTailScreen(state)
    expect(page).toEqual({
      layout: 'text',
      header: 'term · wt-1',
      body: 'No active terminal',
      footer: '2tap=back'
    })
  })

  it('shows "Loading terminal…" for a stale/different terminal subscription (not yet caught up to the frame)', () => {
    const state = fixtureState({
      terminalId: 'other-term',
      lines: ['stale line'],
      frameTerminalId: 'term-1'
    })
    const page = renderTerminalTailScreen(state)
    expect(page).toEqual({
      layout: 'text',
      header: 'term · wt-1',
      body: 'Loading terminal…',
      footer: '2tap=back'
    })
  })

  it('shows "Loading terminal…" while subscribed but no frame has decoded yet', () => {
    const state = fixtureState({
      terminalId: 'term-1',
      lines: [],
      frameTerminalId: 'term-1',
      loading: true
    })
    const page = renderTerminalTailScreen(state)
    expect(page.body).toBe('Loading terminal…')
  })

  it('shows "Terminal unavailable — check phone" when the host never delivered binary frames', () => {
    const state = fixtureState({
      terminalId: 'term-1',
      lines: [],
      frameTerminalId: 'term-1',
      unavailable: true
    })
    const page = renderTerminalTailScreen(state)
    expect(page.body).toBe('Terminal unavailable — check phone')
  })

  it('shows "No output yet" when resolved but the terminal has produced zero lines', () => {
    const state = fixtureState({
      terminalId: 'term-1',
      lines: [],
      frameTerminalId: 'term-1'
    })
    const page = renderTerminalTailScreen(state)
    expect(page.body).toBe('No output yet')
  })

  it('shows the display name and paginates matching terminal content', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    const state = fixtureState({
      terminalId: 'term-1',
      lines,
      frameTerminalId: 'term-1',
      page: 1,
      worktreeId: 'wt-1',
      dashboardRows: [{ worktreeId: 'wt-1', displayName: 'api-refactor', status: 'working' }]
    })
    const pages = paginateHudBody(lines)
    const page = renderTerminalTailScreen(state)
    expect(page.layout).toBe('text')
    if (page.layout !== 'text') {
      throw new Error('expected text layout')
    }
    expect(page.header).toBe(`term · api-refactor · 2/${pages.length}`)
    expect(page.body).toBe(pages[1])
  })

  it('clamps the frame page when it is out of range for the current content', () => {
    const state = fixtureState({
      terminalId: 'term-1',
      lines: ['only line'],
      frameTerminalId: 'term-1',
      page: 9
    })
    const page = renderTerminalTailScreen(state)
    expect(page.layout).toBe('text')
    if (page.layout !== 'text') {
      throw new Error('expected text layout')
    }
    expect(page.header).toBe('term · wt-1 · 1/1')
    expect(page.body).toBe('only line')
  })

  // Finding #8/#2: default to the latest page and keep following new output while page:0.
  describe('follow-latest paging', () => {
    it('defaults to the latest page (not the oldest) when the frame has not scrolled', () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
      const pages = paginateHudBody(lines)
      const state = fixtureState({
        terminalId: 'term-1',
        lines,
        frameTerminalId: 'term-1',
        page: 0
      })
      const page = renderTerminalTailScreen(state)
      expect(page.header).toBe(`term · wt-1 · ${pages.length}/${pages.length}`)
      expect(page.body).toBe(pages.at(-1))
    })

    it('stays on the latest page as new output arrives while unscrolled (page:0)', () => {
      const initialLines = Array.from({ length: 5 }, (_, i) => `line ${i}`)
      const grownLines = [...initialLines, ...Array.from({ length: 10 }, (_, i) => `line ${5 + i}`)]
      const before = renderTerminalTailScreen(
        fixtureState({
          terminalId: 'term-1',
          lines: initialLines,
          frameTerminalId: 'term-1',
          page: 0
        })
      )
      const after = renderTerminalTailScreen(
        fixtureState({
          terminalId: 'term-1',
          lines: grownLines,
          frameTerminalId: 'term-1',
          page: 0
        })
      )
      const grownPages = paginateHudBody(grownLines)
      expect(before.body).toBe(paginateHudBody(initialLines).at(-1))
      expect(after.body).toBe(grownPages.at(-1))
      expect(after.body).not.toBe(before.body) // followed the new tail, not pinned to old content
    })

    it('scrolling back (page > 0) pins a page further into history, not the latest', () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
      const pages = paginateHudBody(lines)
      const state = fixtureState({
        terminalId: 'term-1',
        lines,
        frameTerminalId: 'term-1',
        page: 2
      })
      const page = renderTerminalTailScreen(state)
      expect(page.body).toBe(pages[pages.length - 1 - 2])
      expect(page.body).not.toBe(pages.at(-1))
    })
  })
})
