import { describe, expect, it } from 'vitest'
import { resolveTerminalPaneHandles, terminalPaneViewport } from './mobile-terminal-pane-layout'

describe('mobile terminal split selection', () => {
  it('keeps pane order when focus moves and collapses a closed companion', () => {
    expect(resolveTerminalPaneHandles('b', ['a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b'])
    expect(resolveTerminalPaneHandles('a', ['a', 'b'], ['a', 'c'])).toEqual(['a'])
    expect(resolveTerminalPaneHandles('c', ['a', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'a'])
    expect(resolveTerminalPaneHandles(null, ['a', 'b'], ['a', 'b'])).toEqual([])
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
