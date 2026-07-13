import { describe, expect, it } from 'vitest'
import { CreateTerminalTab, UpdatePaneLayout } from './session-tabs-schemas'

const WT = 'id:wt'

describe('CreateTerminalTab.agent / launchAgent (paired web/mobile session launches)', () => {
  it('accepts a custom agent id for agent and launchAgent', () => {
    const parsed = CreateTerminalTab.parse({
      worktree: WT,
      agent: 'custom:my-agent',
      launchAgent: 'custom:my-agent'
    })

    expect(parsed.agent).toBe('custom:my-agent')
    expect(parsed.launchAgent).toBe('custom:my-agent')
  })

  it('still accepts a built-in TUI agent id', () => {
    const parsed = CreateTerminalTab.parse({
      worktree: WT,
      agent: 'codex',
      launchAgent: 'codex'
    })

    expect(parsed.agent).toBe('codex')
    expect(parsed.launchAgent).toBe('codex')
  })

  it('rejects a malformed agent id', () => {
    expect(() =>
      CreateTerminalTab.parse({
        worktree: WT,
        agent: 'not-a-real-agent'
      })
    ).toThrow('Unknown agent preset')
  })
})

describe('UpdatePaneLayout.root (untrusted remote pane-layout tree)', () => {
  it('accepts a valid split tree', () => {
    const parsed = UpdatePaneLayout.parse({
      worktree: WT,
      tabId: 'tab',
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'a' },
        second: { type: 'leaf', leafId: 'b' },
        ratio: 0.5
      }
    })
    expect(parsed.root).toMatchObject({ type: 'split', direction: 'horizontal' })
  })

  it('accepts a null root', () => {
    expect(UpdatePaneLayout.parse({ worktree: WT, tabId: 'tab', root: null }).root).toBeNull()
  })

  it('rejects an over-deep tree instead of overflowing the stack', () => {
    // Build a tree deeper than the cap (64) without recursion in the test.
    let node: unknown = { type: 'leaf', leafId: 'x' }
    for (let i = 0; i < 5000; i++) {
      node = {
        type: 'split',
        direction: 'vertical',
        first: node,
        second: { type: 'leaf', leafId: 'y' }
      }
    }
    expect(() => UpdatePaneLayout.parse({ worktree: WT, tabId: 'tab', root: node })).toThrow()
  })

  it('rejects a leaf with an invalid leafId', () => {
    expect(() =>
      UpdatePaneLayout.parse({ worktree: WT, tabId: 'tab', root: { type: 'leaf', leafId: '' } })
    ).toThrow()
  })

  it('rejects an unknown node type', () => {
    expect(() =>
      UpdatePaneLayout.parse({ worktree: WT, tabId: 'tab', root: { type: 'bogus' } })
    ).toThrow()
  })

  it('rejects a ratio outside 0..1', () => {
    expect(() =>
      UpdatePaneLayout.parse({
        worktree: WT,
        tabId: 'tab',
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: 'a' },
          second: { type: 'leaf', leafId: 'b' },
          ratio: 5
        }
      })
    ).toThrow()
  })
})
