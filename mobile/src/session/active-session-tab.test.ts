import { describe, expect, it } from 'vitest'
import { resolveActiveSessionTab } from './active-session-tab'

type Tab = { id: string; type: 'terminal' | 'browser' | 'agent-session'; isActive: boolean }

function terminalTab(id: string, isActive: boolean): Tab {
  return { id, type: 'terminal', isActive }
}

function browserTab(id: string, isActive: boolean): Tab {
  return { id, type: 'browser', isActive }
}

describe('resolveActiveSessionTab', () => {
  it('keeps the device on its browser tab when a republication flags the agent terminal active', () => {
    const result = resolveActiveSessionTab(
      [terminalTab('agent', true), browserTab('browser', false)],
      {
        pendingActiveSessionTabId: null,
        selectedSessionTabId: 'browser'
      }
    )

    expect(result.activeTab?.id).toBe('browser')
    expect(result.selectionSource).toBe('selected-tab')
    expect(result.retainSelectedSessionTabId).toBe(false)
  })

  it('keeps the device on a terminal tab when an agent turn flags another terminal active', () => {
    const result = resolveActiveSessionTab(
      [terminalTab('agent', true), terminalTab('shell', false)],
      {
        pendingActiveSessionTabId: null,
        selectedSessionTabId: 'shell'
      }
    )

    expect(result.activeTab?.id).toBe('shell')
  })

  it('follows the host when it explicitly navigates this device', () => {
    const result = resolveActiveSessionTab(
      [terminalTab('agent', true), browserTab('browser', false)],
      {
        pendingActiveSessionTabId: null,
        selectedSessionTabId: 'browser',
        navigationIntent: 'follow'
      }
    )

    expect(result.activeTab?.id).toBe('agent')
    expect(result.selectionSource).toBe('navigation-intent')
    expect(result.retainSelectedSessionTabId).toBe(false)
  })

  it('lets explicit follow supersede an in-flight local activation', () => {
    const result = resolveActiveSessionTab(
      [terminalTab('agent', true), browserTab('browser', false)],
      {
        pendingActiveSessionTabId: 'browser',
        selectedSessionTabId: 'browser',
        navigationIntent: 'follow'
      }
    )

    expect(result.activeTab?.id).toBe('agent')
    expect(result.selectionSource).toBe('navigation-intent')
    expect(result.clearPendingActiveSessionTabId).toBe(true)
  })

  it('falls back to the snapshot but retains the pick while the selected tab is missing', () => {
    const gap = resolveActiveSessionTab([terminalTab('agent', true)], {
      pendingActiveSessionTabId: null,
      selectedSessionTabId: 'browser'
    })

    expect(gap.activeTab?.id).toBe('agent')
    expect(gap.retainSelectedSessionTabId).toBe(true)

    // The guest re-registers and the tab comes back: focus must return to it.
    const restored = resolveActiveSessionTab(
      [terminalTab('agent', true), browserTab('browser', false)],
      { pendingActiveSessionTabId: null, selectedSessionTabId: 'browser' }
    )
    expect(restored.activeTab?.id).toBe('browser')
  })

  it('lets a pending activation win until the snapshot catches up', () => {
    const result = resolveActiveSessionTab(
      [terminalTab('agent', true), browserTab('browser', false)],
      {
        pendingActiveSessionTabId: 'browser',
        selectedSessionTabId: 'agent'
      }
    )

    expect(result.activeTab?.id).toBe('browser')
    expect(result.selectionSource).toBe('pending-tab')
    expect(result.clearPendingActiveSessionTabId).toBe(false)
  })

  it('clears the pending marker once the snapshot acknowledges it', () => {
    const result = resolveActiveSessionTab(
      [terminalTab('agent', false), browserTab('browser', true)],
      {
        pendingActiveSessionTabId: 'browser',
        selectedSessionTabId: 'agent'
      }
    )

    expect(result.activeTab?.id).toBe('browser')
    expect(result.clearPendingActiveSessionTabId).toBe(true)
  })

  it('clears a stale pending marker whose tab is gone', () => {
    const result = resolveActiveSessionTab([terminalTab('agent', true)], {
      pendingActiveSessionTabId: 'removed',
      selectedSessionTabId: null
    })

    expect(result.activeTab?.id).toBe('agent')
    expect(result.clearPendingActiveSessionTabId).toBe(true)
  })

  it('uses the snapshot when the device has no pick yet', () => {
    const result = resolveActiveSessionTab(
      [terminalTab('agent', false), browserTab('browser', true)],
      {
        pendingActiveSessionTabId: null,
        selectedSessionTabId: null
      }
    )

    expect(result.activeTab?.id).toBe('browser')
    expect(result.selectionSource).toBe('snapshot')
  })

  it('opens the chat a create-worktree launch landed on, over the workspace shell', () => {
    // Why: a workspace created from the mobile sheet with an agent arrives on a fresh route with
    // no device pick, so the host's own activation is the only thing that says "open the chat".
    // `agent.launch` publishes and activates that tab before it answers, so it is already in the
    // first snapshot the route fetches.
    const result = resolveActiveSessionTab(
      [
        { id: 'shell', type: 'terminal', isActive: false },
        { id: 'agent-session:s-1', type: 'agent-session', isActive: true }
      ],
      { pendingActiveSessionTabId: null, selectedSessionTabId: null }
    )

    expect(result.activeTab?.id).toBe('agent-session:s-1')
    expect(result.selectionSource).toBe('snapshot')
  })

  it('returns null for an empty snapshot', () => {
    expect(
      resolveActiveSessionTab([], { pendingActiveSessionTabId: null, selectedSessionTabId: 'x' })
        .activeTab
    ).toBeNull()
  })
})
