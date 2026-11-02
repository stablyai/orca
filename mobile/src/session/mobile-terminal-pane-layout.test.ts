import { describe, expect, it } from 'vitest'
import {
  resolveTerminalPaneHandles,
  terminalPaneDirection,
  terminalPaneViewport
} from './mobile-terminal-pane-layout'

describe('mobile terminal split selection', () => {
  it('keeps pane order when focus moves and collapses a closed companion', () => {
    expect(resolveTerminalPaneHandles('b', ['a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b'])
    expect(resolveTerminalPaneHandles('a', ['a', 'b'], ['a', 'c'])).toEqual(['a'])
    expect(resolveTerminalPaneHandles('c', ['a', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'a'])
    expect(resolveTerminalPaneHandles(null, ['a', 'b'], ['a', 'b'])).toEqual([])
  })
  it('uses usable bounds for folded portrait and wide landscape', () => {
    expect(terminalPaneDirection({ width: 390, height: 700 })).toBe('column')
    expect(terminalPaneDirection({ width: 700, height: 900 })).toBe('column')
    expect(terminalPaneDirection({ width: 850, height: 330 })).toBe('row')
    expect(terminalPaneDirection({ width: 1100, height: 700 })).toBe('row')
  })
  it('never shares geometry ownership across terminal handles', () => {
    const states = new Map()
    const a = terminalPaneViewport(states, 'a')
    const b = terminalPaneViewport(states, 'b')
    a.viewportRef.current = { cols: 40, rows: 30 }
    expect(b.viewportRef.current).toBeNull()
    expect(terminalPaneViewport(states, 'a')).toBe(a)
  })
})

it('keeps both stacked pane windows above a keyboard taller than one pane without resizing their grids', async () => {
  const { terminalPaneKeyboardLayout } = await import('./mobile-terminal-pane-layout')
  const frame = { width: 390, height: 500 }
  const upper = terminalPaneKeyboardLayout(frame, 'column', 0, 300)
  const lower = terminalPaneKeyboardLayout(frame, 'column', 1, 300)
  expect(upper).toEqual({ top: 0, height: 100, originalHeight: 250, occlusion: 150 })
  expect(lower).toEqual({ top: 100, height: 100, originalHeight: 250, occlusion: 150 })
  const heading = 28
  const lastRowBottom = lower.top + heading + (lower.originalHeight - heading) - lower.occlusion
  expect(lastRowBottom).toBe(200)
  expect(lastRowBottom).toBeGreaterThan(lower.top + heading)
  expect(lastRowBottom).toBeLessThanOrEqual(frame.height - 300)
  expect(terminalPaneKeyboardLayout(frame, 'column', 1, 0).originalHeight).toBe(
    lower.originalHeight
  )
})
