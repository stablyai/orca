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
}): HudState {
  return {
    connection: { hostId: 'h1', state: 'connected', compat: null },
    hosts: [],
    dashboard: { rows: opts.dashboardRows ?? [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: opts.terminalId, lines: opts.lines, live: true },
    device: null,
    askAnswered: null,
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
  it('shows empty content while terminalId is still resolving (frame terminalId "" placeholder)', () => {
    const state = fixtureState({ terminalId: null, lines: [], frameTerminalId: '' })
    const page = renderTerminalTailScreen(state)
    expect(page).toEqual({
      layout: 'text',
      header: 'term · wt-1 · 1/1',
      body: '',
      footer: 'scroll=pages  2tap=back'
    })
  })

  it('ignores lines from a stale/different terminal subscription', () => {
    const state = fixtureState({
      terminalId: 'other-term',
      lines: ['stale line'],
      frameTerminalId: 'term-1'
    })
    const page = renderTerminalTailScreen(state)
    expect(page.layout).toBe('text')
    if (page.layout !== 'text') {
      throw new Error('expected text layout')
    }
    expect(page.body).toBe('')
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
})
