import { describe, expect, it } from 'vitest'
import { buildVisibleSnapshotReadFallback } from './terminal-tail-read'
import type { RuntimeTerminalRead } from '../../shared/runtime-terminal-contracts'

function baseRead(overrides: Partial<RuntimeTerminalRead> = {}): RuntimeTerminalRead {
  return {
    handle: 'term_1',
    status: 'running',
    tail: ['stream line'],
    truncated: false,
    nextCursor: null,
    ...overrides
  }
}

describe('screen renderability contract', () => {
  it('does not mark ordinary visible-snapshot fallbacks as renderable', () => {
    const fallback = buildVisibleSnapshotReadFallback(baseRead(), ['Visible TUI'], 100)

    expect(fallback).toMatchObject({
      source: 'screen',
      tail: ['Visible TUI']
    })
    expect(fallback.renderable).toBeUndefined()
  })

  it('lets explicit screen reads stamp renderable after the shared helper', () => {
    const fallback = buildVisibleSnapshotReadFallback(baseRead(), ['Visible TUI'], 100)
    const screenRead = { ...fallback, renderable: true as const }

    expect(screenRead.renderable).toBe(true)
    expect(screenRead.source).toBe('screen')
  })
})
