import { beforeEach, describe, expect, it } from 'vitest'
import { paginateHudBody } from '../hud/hud-text-pagination'
import type { DashboardRow, HudState } from '../state/hud-store'
import { terminalTailBrowseFreeze } from '../state/terminal-tail-state'
import { renderTerminalTailScreen, terminalTailPageCount } from './terminal-tail-screen'

const PAGINATION_OPTS = { maxGlyphsPerLine: 56 }

// The screen freezes a browsing snapshot in a module-level singleton (only one terminal-tail
// screen is ever visible at a time) — reset it before every case so tests don't leak into
// each other via lingering nonzero-page state.
beforeEach(() => terminalTailBrowseFreeze.reset())

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
  // Finding #4 (residual): the "" placeholder means the openTerminalTail resolution round-trip
  // is still in flight — that's "Resolving…", distinct from the "No active terminal" end state.
  it('shows "Resolving terminal…" while the frame terminalId is still the "" placeholder', () => {
    const state = fixtureState({ terminalId: null, lines: [], frameTerminalId: '' })
    const page = renderTerminalTailScreen(state)
    expect(page).toEqual({
      layout: 'text',
      header: 'term · wt-1',
      body: 'Resolving terminal…',
      footer: '2tap=back'
    })
  })

  it('shows "Resolving terminal…" for a mismatched subscription that is actively loading', () => {
    const state = fixtureState({
      terminalId: 'other-term',
      lines: ['stale line'],
      frameTerminalId: 'term-1',
      loading: true
    })
    const page = renderTerminalTailScreen(state)
    expect(page).toEqual({
      layout: 'text',
      header: 'term · wt-1',
      body: 'Resolving terminal…',
      footer: '2tap=back'
    })
  })

  it('shows "No active terminal" for a mismatched subscription with nothing pending (finding #4 residual end state)', () => {
    const state = fixtureState({
      terminalId: 'other-term',
      lines: ['stale line'],
      frameTerminalId: 'term-1'
    })
    const page = renderTerminalTailScreen(state)
    expect(page).toEqual({
      layout: 'text',
      header: 'term · wt-1',
      body: 'No active terminal',
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

  // Finding: browsing history must not jump underfoot when new output arrives — reproduced
  // with 18 lines at offset 1, appending a 19th line.
  describe('frozen browsing window while reading history', () => {
    it('keeps the displayed page stable while browsing as output appends, then catches up at latest', () => {
      const lines = Array.from({ length: 18 }, (_, i) => `line ${i}`)
      const before = renderTerminalTailScreen(
        fixtureState({ terminalId: 'term-1', lines, frameTerminalId: 'term-1', page: 1 })
      )

      const grown = [...lines, 'line 18']
      const whileBrowsing = renderTerminalTailScreen(
        fixtureState({ terminalId: 'term-1', lines: grown, frameTerminalId: 'term-1', page: 1 })
      )
      // Still browsing (page unchanged) — the appended line must not move the current page.
      expect(whileBrowsing).toEqual(before)

      const atLatest = renderTerminalTailScreen(
        fixtureState({ terminalId: 'term-1', lines: grown, frameTerminalId: 'term-1', page: 0 })
      )
      const latestPages = paginateHudBody(grown, PAGINATION_OPTS)
      expect(atLatest.body).toBe(latestPages.at(-1))
      expect(atLatest.body).toContain('line 18') // returning to latest shows the new output
    })

    it('resumes following live output immediately once back at page 0 (no freeze lingers)', () => {
      const lines = Array.from({ length: 18 }, (_, i) => `line ${i}`)
      renderTerminalTailScreen(
        fixtureState({ terminalId: 'term-1', lines, frameTerminalId: 'term-1', page: 1 })
      )
      const grown = [...lines, 'line 18', 'line 19']
      const atLatest = renderTerminalTailScreen(
        fixtureState({ terminalId: 'term-1', lines: grown, frameTerminalId: 'term-1', page: 0 })
      )
      expect(atLatest.body).toBe(paginateHudBody(grown, PAGINATION_OPTS).at(-1))
    })
  })

  // Finding #19 (residual): a raw terminal line can be far wider than the 576px body can show
  // on one visual row.
  describe('long-line page budget', () => {
    it('wraps an oversized single line into its visual row count instead of overflowing a page', () => {
      const shortLines = Array.from({ length: 5 }, (_, i) => `short${i}`)
      const longLine = 'x'.repeat(300)
      const lines = [...shortLines, longLine]

      // Without the glyph-width budget the 300-char line only "counts" as one line entry, so
      // everything wrongly fits on a single page (the bug: it overflows the body at render time).
      expect(paginateHudBody(lines).length).toBe(1)

      const pageCount = terminalTailPageCount(lines)
      expect(pageCount).toBeGreaterThan(1)

      const state = fixtureState({
        terminalId: 'term-1',
        lines,
        frameTerminalId: 'term-1',
        page: 0
      })
      const page = renderTerminalTailScreen(state)
      expect(page.header).toBe(`term · wt-1 · ${pageCount}/${pageCount}`)
      for (const row of page.body.split('\n')) {
        expect(row.length).toBeLessThanOrEqual(56)
      }
    })
  })
})
