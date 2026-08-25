import { describe, expect, it } from 'vitest'

import { AgentSessionPaneBindings } from './agent-session-pane-bindings'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE_A = makePaneKey('tab-1', 'aaaaaaaa-1111-4111-8111-111111111111')
const PANE_B = makePaneKey('tab-1', 'bbbbbbbb-2222-4222-8222-222222222222')

describe('AgentSessionPaneBindings', () => {
  it('resolves only the source it was bound under', () => {
    const bindings = new AgentSessionPaneBindings()
    bindings.bind('claude', 'sess-1', { paneKey: PANE_A, ptyId: 'pty-1' })

    expect(bindings.resolve('claude', 'sess-1')?.paneKey).toBe(PANE_A)
    expect(bindings.resolve('codex', 'sess-1')).toBeNull()
    expect(bindings.resolve('claude', 'sess-2')).toBeNull()
    expect(bindings.resolve('claude', null)).toBeNull()
  })

  it('follows a session that re-binds to another pane', () => {
    const bindings = new AgentSessionPaneBindings()
    bindings.bind('claude', 'sess-1', { paneKey: PANE_A, ptyId: 'pty-1' })
    bindings.bind('claude', 'sess-1', { paneKey: PANE_B, ptyId: 'pty-2' })

    expect(bindings.resolve('claude', 'sess-1')?.paneKey).toBe(PANE_B)
    expect(bindings.size()).toBe(1)
  })

  it('drops every binding a dying PTY established, and only those', () => {
    const bindings = new AgentSessionPaneBindings()
    bindings.bind('claude', 'sess-1', { paneKey: PANE_A, ptyId: 'pty-1' })
    bindings.bind('claude', 'sess-2', { paneKey: PANE_A, ptyId: 'pty-1' })
    bindings.bind('claude', 'sess-3', { paneKey: PANE_B, ptyId: 'pty-2' })

    bindings.clearForPty('pty-1')

    expect(bindings.resolve('claude', 'sess-1')).toBeNull()
    expect(bindings.resolve('claude', 'sess-2')).toBeNull()
    expect(bindings.resolve('claude', 'sess-3')?.paneKey).toBe(PANE_B)
  })

  it('evicts least-recently-bound sessions past the cap, keeping a re-bound one alive', () => {
    const bindings = new AgentSessionPaneBindings()
    bindings.bind('claude', 'sess-0', { paneKey: PANE_A, ptyId: 'pty-0' })
    for (let i = 1; i < 512; i += 1) {
      bindings.bind('claude', `sess-${i}`, { paneKey: PANE_B, ptyId: `pty-${i}` })
    }
    // Touch the oldest so it is no longer the eviction candidate.
    bindings.bind('claude', 'sess-0', { paneKey: PANE_A, ptyId: 'pty-0' })
    bindings.bind('claude', 'sess-512', { paneKey: PANE_B, ptyId: 'pty-512' })

    expect(bindings.size()).toBe(512)
    expect(bindings.resolve('claude', 'sess-0')?.paneKey).toBe(PANE_A)
    expect(bindings.resolve('claude', 'sess-1')).toBeNull()
    expect(bindings.resolve('claude', 'sess-512')?.paneKey).toBe(PANE_B)
  })

  it('ignores incomplete bindings rather than storing an unroutable row', () => {
    const bindings = new AgentSessionPaneBindings()
    bindings.bind('claude', '   ', { paneKey: PANE_A, ptyId: 'pty-1' })
    bindings.bind('claude', 'sess-1', { paneKey: '', ptyId: 'pty-1' })
    bindings.bind('claude', 'sess-2', { paneKey: PANE_A, ptyId: '' })

    expect(bindings.size()).toBe(0)
  })
})
